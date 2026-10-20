// 梯队评价表考勤时长回填插件（可拔插）
const cron = require('node-cron');
const config = require('./config');
const feishuAttendance = require('../../zklink/feishuAttendance');
const report = require('../../zklink/report');
const { getTenantAccessToken } = require('../../feishu/client');
const { addDays, mondayOf, shanghaiParts } = require('../../utils/dates');

const OPEN_API = 'https://open.feishu.cn/open-apis';
const DAY_MS = 24 * 3600 * 1000;
let cronStarted = false;

async function api(token, method, apiPath, body) {
  const res = await fetch(`${OPEN_API}${apiPath}`, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => null);
  if (!j) throw new Error(`飞书接口返回非 JSON（HTTP ${res.status}）`);
  if (j.code !== 0) {
    const err = new Error(`飞书接口错误 ${j.code}: ${j.msg || ''}`);
    err.errcode = j.code;
    throw err;
  }
  return j.data || {};
}

async function fetchFields(token, appToken, tableId) {
  const d = await api(token, 'GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
  return d.items || [];
}

async function listAllRecords(token, appToken, tableId) {
  const out = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (pageToken) qs.set('page_token', pageToken);
    const d = await api(token, 'GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/records?${qs.toString()}`);
    out.push(...(d.items || []));
    pageToken = d.has_more ? (d.page_token || '') : '';
  } while (pageToken);
  return out;
}

/**
 * 平台班段聚合（与 ZKLink 周报同一口径：平台上下班配对、工作日 06:00 切天、
 * 跨天班次计入起始日、缺卡不计时长）。插件只消费 agg.users 的 totalMs/openId。
 */
async function computeWeekAgg(weekStartStr) {
  const start = Date.parse(`${weekStartStr}T00:00:00+08:00`);
  if (!Number.isFinite(start)) throw new Error(`周起始日非法：${weekStartStr}`);
  const end = start + 7 * DAY_MS;
  const tasks = await feishuAttendance.fetchTaskSessions(start, end);
  let members = [];
  try {
    const gm = await feishuAttendance.resolveGroupMembers();
    members = (gm && gm.members) || [];
  } catch (e) {
    console.warn(`[梯队回填] 考勤组名单解析失败（${e.message}），尝试通讯录`);
  }
  if (!members.length) {
    try {
      members = await feishuAttendance.listUsersWithUserId();
    } catch (e) {
      console.warn(`[梯队回填] 通讯录名单也取不到（${e.message}），仅按打卡记录匹配`);
    }
  }
  const agg = report.aggregateSessions(tasks.sessions, members);
  return { weekStartStr, start, end, agg, sessions: tasks.sessions };
}

/** 目标周一 → 表内第几组（0 起）；首组周一由 ROSTER_FILL_FIRST_WEEK_START 指定 */
function resolveGroupIndex(weekStartStr) {
  if (!config.firstWeekStart) throw new Error('未配置 ROSTER_FILL_FIRST_WEEK_START');
  const first = Date.parse(`${config.firstWeekStart}T00:00:00+08:00`);
  const target = Date.parse(`${weekStartStr}T00:00:00+08:00`);
  if (!Number.isFinite(first) || !Number.isFinite(target)) throw new Error('周起始日非法');
  const diff = target - first;
  if (diff % (7 * DAY_MS) !== 0) {
    throw new Error(`周起始日不是整周偏移：${weekStartStr}（首组 ${config.firstWeekStart}）`);
  }
  return diff / (7 * DAY_MS);
}

/**
 * 填某一周：按组序号选「时段」分组 → 按 open_id（姓名兜底）匹配名单 → 写考勤时长。
 * @param {object} opts
 * @param {string} opts.weekStartStr 目标周一 YYYY-MM-DD
 * @param {boolean} [opts.dryRun=true] 默认只预览不写表
 * @param {boolean} [opts.overwrite] 已有值时是否覆盖（默认取配置）
 */
async function fillWeek({ weekStartStr, dryRun = true, overwrite = config.overwrite } = {}) {
  if (!config.appToken || !config.tableId) {
    throw new Error('未配置 ROSTER_FILL_APP_TOKEN / ROSTER_FILL_TABLE_ID');
  }
  const week = String(weekStartStr || '');
  const groupIndex = resolveGroupIndex(week);
  const { agg } = await computeWeekAgg(week);
  const token = await getTenantAccessToken();
  const fields = await fetchFields(token, config.appToken, config.tableId);
  const fMember = fields.find((f) => f.field_name === config.fields.member);
  const fDuration = fields.find((f) => f.field_name === config.fields.duration);
  const fPeriod = fields.find((f) => f.field_name === config.fields.period);
  if (!fMember || !fDuration || !fPeriod) {
    const missing = [
      !fMember && config.fields.member,
      !fDuration && config.fields.duration,
      !fPeriod && config.fields.period,
    ].filter(Boolean);
    throw new Error(`目标表缺少字段：${missing.join('、')}`);
  }
  const options = (fPeriod.property && fPeriod.property.options) || [];
  if (groupIndex < 0 || groupIndex >= options.length) {
    throw new Error(`周 ${week} 对应第 ${groupIndex + 1} 组，超出表内时段范围（共 ${options.length} 组：${options.map((o) => o.name).join('、')}）`);
  }
  const periodName = options[groupIndex].name;
  const records = (await listAllRecords(token, config.appToken, config.tableId)).filter(
    (r) => String((r.fields || {})[config.fields.period] || '').toLowerCase() === periodName.toLowerCase()
  );

  const byOpen = new Map(agg.users.filter((u) => u.openId).map((u) => [u.openId, u]));
  const byName = new Map(agg.users.map((u) => [u.name, u]));
  const plan = [];
  const unmatched = [];
  const skipped = [];
  const updates = [];

  for (const r of records) {
    const f = r.fields || {};
    const p = Array.isArray(f[config.fields.member]) ? f[config.fields.member][0] : null;
    const name = p ? p.name : '（空）';
    const openId = p ? p.id : '';
    const u = (openId && byOpen.get(openId)) || byName.get(name) || null;
    if (!u) {
      unmatched.push({ recordId: r.record_id, name, openId });
      continue;
    }
    const hours = Math.round((u.totalMs / 3600000) * 10) / 10;
    const old = f[config.fields.duration];
    if (!overwrite && old != null) {
      skipped.push({ recordId: r.record_id, name, old });
      continue;
    }
    updates.push({ record_id: r.record_id, fields: { [config.fields.duration]: hours } });
    plan.push({
      recordId: r.record_id,
      name,
      openId,
      hours,
      old: old == null ? null : old,
      punchDays: u.punchDays,
      completeSessions: u.completeSessions,
      missingSessions: u.missingSessions,
    });
  }

  let updated = 0;
  if (!dryRun && updates.length) {
    const d = await api(
      token,
      'POST',
      `/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records/batch_update`,
      { records: updates }
    );
    updated = (d.records || []).length || updates.length;
  }
  return {
    weekStart: week,
    weekEnd: addDays(week, 6),
    groupIndex,
    period: periodName,
    dryRun,
    matched: plan.length,
    unmatched,
    skipped,
    plan,
    updated,
  };
}

/** 上一周周一（上海挂钟；周一 09:40 触发时 = 刚结束的那一周） */
function previousWeekStart(now = new Date()) {
  return mondayOf(addDays(shanghaiParts(now).dateStr, -7));
}

/** 启动每周 cron（插件内部自管；关闭开关即不注册） */
function startCron() {
  if (cronStarted) return true;
  if (!config.enabled) return false;
  cronStarted = true;
  cron.schedule(
    config.cron,
    async () => {
      try {
        const weekStart = previousWeekStart();
        const r = await fillWeek({ weekStartStr: weekStart, dryRun: false });
        console.log(
          `[梯队回填] ${r.weekStart}~${r.weekEnd} → 第 ${r.groupIndex + 1} 组（${r.period}）：写入 ${r.updated} 条，匹配 ${r.matched}，未匹配 ${r.unmatched.length}${r.skipped.length ? `，跳过 ${r.skipped.length}` : ''}`
        );
        for (const u of r.unmatched) {
          console.warn(`[梯队回填] 未匹配：${u.name}（${u.openId || '无 open_id'}）——该行未回写`);
        }
      } catch (e) {
        console.error('[梯队回填] 周回填失败:', e.message);
      }
    },
    { timezone: config.timezone }
  );
  console.log(`[梯队回填] 插件已启用：${config.cron}（${config.timezone}）；首组周 ${config.firstWeekStart || '未配置'}`);
  return true;
}

function startIfEnabled() {
  if (!config.enabled) return false;
  if (!config.appToken || !config.tableId) {
    console.warn('[梯队回填] 未配置 ROSTER_FILL_APP_TOKEN / ROSTER_FILL_TABLE_ID，插件不启动');
    return false;
  }
  if (!config.firstWeekStart) {
    console.warn('[梯队回填] 未配置 ROSTER_FILL_FIRST_WEEK_START，插件不启动');
    return false;
  }
  return startCron();
}

module.exports = {
  enabled: config.enabled,
  fillWeek,
  computeWeekAgg,
  previousWeekStart,
  resolveGroupIndex,
  startCron,
  startIfEnabled,
};
