// ============================================================
// 云文档留档（docx API，应用身份复用 duty-bot 的 APP_ID/APP_SECRET）
//
// ARCHIVE_DOC_TOKEN（ZKLINK_ARCHIVE_DOC_TOKEN）兼容两种形态（2026-10-07 曼波指定
// wiki 节点）：wiki 节点 token 先经 get_node API 换算出真实 obj_token（应用需
// wiki:wiki:readonly 权限），解析结果缓存；docx token 原样用。
// 应用无 docx 权限/未加文档协作者时报错带指引（不影响播报，watchdog 自动重试）。
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getTenantAccessToken } = require('../feishu/client');
const report = require('./report');

const OPEN_API = 'https://open.feishu.cn/open-apis';

let wikiResolveCache = { token: '', objToken: '', objType: '', resolvedAt: 0 };

function describeDocxErrcode(code) {
  if (code === 1770002 || code === 1770001) return '云文档不存在或无权限：确认 ZKLINK_ARCHIVE_DOC_TOKEN 正确，且应用已被加为该文档协作者（可编辑）';
  if (code === 99991663 || code === 99991661) return '应用身份无权限：飞书后台需给本应用开通 docx:document 权限（查看、编辑和管理云文档）';
  return '';
}

function feishuDocError(code, msg) {
  const err = new Error(`飞书接口错误 ${code}: ${msg || ''}`);
  err.errcode = code;
  err.hint = describeDocxErrcode(code);
  return err;
}

// ---- docx 块构造（文本块=2，heading1=3 / heading2=4 / heading3=5） ----
function textBlock(content) {
  return { block_type: 2, text: { elements: [{ text_run: { content } }], style: {} } };
}
function headingBlock(level, content) {
  const key = `heading${level}`;
  return { block_type: 2 + level, [key]: { elements: [{ text_run: { content } }], style: {} } };
}

// wiki 节点 token → 真实 docx token；非 wiki token（get_node 报错）原样返回按 docx 处理
async function resolveDocToken(token) {
  if (wikiResolveCache.token === token && wikiResolveCache.objToken) return wikiResolveCache;
  try {
    const t = await getTenantAccessToken();
    const res = await fetch(`${OPEN_API}/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${t}` },
    });
    const j = await res.json();
    if (j.code === 0 && j.data && j.data.node && j.data.node.obj_token) {
      wikiResolveCache = { token, objToken: j.data.node.obj_token, objType: j.data.node.obj_type || '', resolvedAt: Date.now() };
      return wikiResolveCache;
    }
    console.warn(`[打卡留档] wiki 节点解析未命中（code=${j.code} ${j.msg || ''}），按 docx token 直接使用`);
  } catch (e) {
    console.warn(`[打卡留档] wiki 节点解析异常（${e.message}），按 docx token 直接使用`);
  }
  return { token, objToken: token, objType: 'docx', resolvedAt: Date.now() };
}

// 一次 children 请求上限 50 块（官方限制），超量分批顺序追加（全部追加到文档末尾）
async function appendDocBlocks(docToken, blocks) {
  if (!docToken) {
    const err = new Error('未配置 ZKLINK_ARCHIVE_DOC_TOKEN（云文档 token，wiki 链接 /wiki/ 后段或 docx token）');
    err.errcode = 'NO_CONFIG';
    throw err;
  }
  const token = await getTenantAccessToken();
  let appended = 0;
  for (let i = 0; i < blocks.length; i += 50) {
    const chunk = blocks.slice(i, i + 50);
    const res = await fetch(`${OPEN_API}/docx/v1/documents/${docToken}/blocks/${docToken}/children?document_revision_id=-1`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ children: chunk, index: -1 }),
    });
    const j = await res.json();
    if (j.code !== 0) throw feishuDocError(j.code, j.msg);
    appended += chunk.length;
  }
  return appended;
}

// ---- 多维表格归档（2026-10-12 曼波定：归档落点=wiki「打卡记录」bitable，按人每周一行） ----
// 字段按 type 识别（改名无感）：11=人员 / 1=该周时长(文本) / 7=是否及格 / 2=第几周(数字)。
// 人员列写 open_id（bitable User 字段不收 employee_id，1254066 UserFieldConvFail 实锤）；
// 通讯录可见范围外的人拿不到 open_id——该行人员列留空但时长照写（warn 汇总，不阻塞归档）。
const FIELD_TYPE = { USER: 11, TEXT: 1, NUMBER: 2, CHECKBOX: 7 };

async function bitableCall(appToken, path, options = {}) {
  const token = await getTenantAccessToken();
  const res = await fetch(`${OPEN_API}/bitable/v1/apps/${appToken}/tables/${path}`, {
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...options,
  });
  const j = await res.json();
  if (j.code !== 0) throw feishuDocError(j.code, j.msg || `HTTP ${res.status}`);
  return j.data || {};
}

// 表字段按 type 归位；人员列与时长列是归档的最小必需（缺了写了也没意义，直接报错）
async function resolveArchiveFields(appToken, tableId) {
  const data = await bitableCall(appToken, `${tableId}/fields?page_size=50`);
  const items = data.items || [];
  const first = (type) => items.find((f) => f.type === type);
  const fields = {
    user: first(FIELD_TYPE.USER),
    duration: first(FIELD_TYPE.TEXT),
    pass: first(FIELD_TYPE.CHECKBOX),
    week: first(FIELD_TYPE.NUMBER),
  };
  if (!fields.user || !fields.duration) {
    const err = new Error(`多维表格缺人员/时长列（按字段类型 ${FIELD_TYPE.USER}/${FIELD_TYPE.TEXT} 识别），现有类型：${items.map((f) => f.type).join(',')}——请检查「打卡记录」表结构`);
    err.errcode = 'BAD_TABLE';
    throw err;
  }
  return fields;
}

// 通讯录全量 user_id→open_id（GET /contact/v3/users 老端点全树遍历；find_by_department 新端点
// 只见 13 人且部门接口 99992357——2026-10-12 实测）。用户 department_ids 反向发现子部门。
async function fetchOpenIdMap() {
  const token = await getTenantAccessToken();
  const map = {};
  const depts = ['0'];
  const seen = new Set();
  while (depts.length) {
    const d = depts.shift();
    let pageToken = '';
    do {
      const qs = new URLSearchParams({ department_id: d, user_id_type: 'user_id', page_size: '50' });
      if (pageToken) qs.set('page_token', pageToken);
      const res = await fetch(`${OPEN_API}/contact/v3/users?${qs}`, {
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (j.code !== 0) { console.warn(`[打卡留档] 通讯录部门 ${d} 拉取失败（${j.code} ${j.msg || ''}），跳过`); break; }
      for (const p of (j.data && j.data.items) || []) {
        if (p.user_id && p.open_id && !map[p.user_id]) map[p.user_id] = p.open_id;
        for (const dd of (p.department_ids || [])) if (!seen.has(dd)) { seen.add(dd); depts.push(dd); }
      }
      pageToken = (j.data && j.data.page_token) || '';
    } while (pageToken);
  }
  return map;
}

// 第几周：归档窗口周一（win.startWall）与学期第 1 周周一差值；未配置锚点返回 null
function weekNumberOf(win) {
  if (!config.week1Start) return null;
  const [y, m, d] = config.week1Start.split('-').map(Number);
  if (!y || !m || !d) return null;
  const w1 = Date.UTC(y, m - 1, d, 16, 0, 0); // 上海 00:00 = UTC 前一日 16:00
  return Math.round((win.startWall - w1) / (7 * 24 * 3600 * 1000)) + 1;
}

// 已有同周行则跳过（幂等：重试/手动重跑不重复写行）。
// 注意 records 接口返回的 fields 键=字段名（非 field_id），按名匹配。
async function bitableWeekExists(appToken, tableId, weekFieldName, weekNum) {
  if (weekNum == null || !weekFieldName) return false;
  const data = await bitableCall(appToken, `${tableId}/records?page_size=500`);
  return ((data.items || []).some((r) => Number(r.fields && r.fields[weekFieldName]) === weekNum));
}

async function archiveToBitable(win, agg, appToken) {
  const tableId = config.archiveTableId || ((await bitableCall(appToken, 'tables?page_size=20')).items || [])[0]?.table_id;
  if (!tableId) {
    const err = new Error('多维表格归档未定位到数据表：请配置 ZKLINK_ARCHIVE_TABLE_ID（表格链接 ?table= 参数值）');
    err.errcode = 'NO_CONFIG';
    throw err;
  }
  const fields = await resolveArchiveFields(appToken, tableId);
  const weekNum = weekNumberOf(win);
  if (await bitableWeekExists(appToken, tableId, fields.week && fields.week.field_name, weekNum)) {
    console.log(`[打卡留档] 多维表格已有第 ${weekNum} 周行，跳过重复归档`);
    return { appended: 0, tableId, skipped: true };
  }

  const openIdMap = await fetchOpenIdMap(); // 名单不带 openId 时的兜底映射
  const rows = [];
  const noOpenId = [];
  for (const u of agg.users) {
    const fieldsBody = {};
    const oid = u.openId || openIdMap[u.userid];
    if (oid) fieldsBody[fields.user.field_name] = [{ id: oid }];
    else noOpenId.push(u.name);
    fieldsBody[fields.duration.field_name] = report.fmtDuration(u.totalMs);
    if (fields.pass && config.passHours > 0) fieldsBody[fields.pass.field_name] = u.totalMs >= config.passHours * 3600 * 1000;
    if (fields.week && weekNum != null) fieldsBody[fields.week.field_name] = weekNum;
    rows.push({ fields: fieldsBody });
  }
  if (noOpenId.length) console.warn(`[打卡留档] ${noOpenId.length} 人不在通讯录可见范围、人员列留空：${noOpenId.join('、')}（名单源修复后可重置归档水位补全）`);

  let appended = 0;
  for (let i = 0; i < rows.length; i += 500) {
    await bitableCall(appToken, `${tableId}/records/batch_create`, {
      method: 'POST',
      body: JSON.stringify({ records: rows.slice(i, i + 500) }),
    });
    appended += Math.min(500, rows.length - i);
  }
  return { appended, tableId };
}

// 本地留档（JSON 全量 + CSV 日明细）；失败仅 warn 不阻塞播报
function archiveLocal(win, agg, records, extra = {}) {
  const result = { files: [], error: null };
  try {
    fs.mkdirSync(config.archiveDir, { recursive: true });
    const base = path.join(config.archiveDir, `考勤周报_${win.key}`);
    const jsonPath = `${base}.json`;
    fs.writeFileSync(jsonPath, JSON.stringify({
      window: { key: win.key, label: win.label, start: win.start, end: win.end },
      dataSource: extra.dataSource || config.dataSource,
      generatedAt: new Date().toISOString(),
      totals: agg.totals,
      users: agg.users,
      records,
    }, null, 2) + '\n');
    const csvPath = `${base}.csv`;
    fs.writeFileSync(csvPath, report.renderCsv(win, agg));
    result.files = [jsonPath, csvPath];
  } catch (e) {
    result.error = e.message;
    console.warn('[打卡留档] 本地留档失败（不影响播报）:', e.message);
  }
  return result;
}

// 云文档块序列：heading2 周标题节 + 口径/汇总 + 每人一行 + 全部打卡记录逐条
function buildDocBlocks(win, agg, records, extra = {}) {
  const blocks = [
    headingBlock(2, `⏱ 打卡时长周报（${win.label}）`),
    textBlock(`生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')} · 数据源：${extra.dataSource || config.dataSource}（ZKLink 云考勤${extra.groupLabel ? ` · 考勤组：${extra.groupLabel}` : ''}）`),
    textBlock(`口径：按人按上海挂钟日聚合，当日打卡按顺序两两配对（1→2、3→4…）记「段末−段首」之和；奇数张末张落单不计（落单卡），跨天相邻卡不配对，恰 1 条记 0（孤条）。`),
    textBlock(`合计：打卡 ${agg.totals.punches} 条 · 总时长 ${report.fmtDuration(agg.totals.totalMs)} · 涉及 ${agg.totals.users} 人（有打卡 ${agg.totals.punchUsers} 人）${agg.totals.lonelyDays ? ` · 孤条 ${agg.totals.lonelyDays} 天` : ''}${agg.totals.leftoverCards ? ` · 落单 ${agg.totals.leftoverCards} 卡` : ''}`),
    headingBlock(3, '本周汇总'),
  ];
  for (const u of agg.users) {
    const lonely = u.lonelyDays ? ` · 孤条 ${u.lonelyDays} 天` : '';
    blocks.push(textBlock(`• ${u.name}（${u.userid}）：${u.punchDays} 天 · ${report.fmtDuration(u.totalMs)}${lonely}`));
  }
  blocks.push(headingBlock(3, `打卡明细（全部 ${records.length} 条记录）`));
  for (const r of records) {
    const mi = (agg.userNames && agg.userNames.get(r.userid)) || null; // memberMap：{name, openId}
    const name = (mi && mi.name) || r._name || r.userid;
    const meta = [r.checkin_type, r.exception_type && `异常:${r.exception_type}`, r.groupname].filter(Boolean).join(' · ');
    blocks.push(textBlock(`• ${report.fmtTime(r.checkin_time * 1000)} ${name}（${r.userid}）${meta ? ` — ${meta}` : ''}`));
  }
  if (!records.length) blocks.push(textBlock('• （本窗口无打卡记录）'));
  return blocks;
}

// 追加到云文档末尾（自动解析 wiki 节点）；返回追加块数。
// objType=bitable 时走多维表格归档（2026-10-12 曼波定：归档落点=「打卡记录」bitable，
// 按人每周一行——docx 分支从未成功落档过，bitable 是首个真归档形态）。
async function archiveToDoc(win, agg, records, extra = {}) {
  const resolved = await resolveDocToken(config.archiveDocToken);
  if (resolved.objType === 'bitable') {
    const r = await archiveToBitable(win, agg, resolved.objToken);
    return { appended: r.appended, objToken: resolved.objToken, objType: resolved.objType, tableId: r.tableId, skipped: !!r.skipped };
  }
  const blocks = buildDocBlocks(win, agg, records, extra);
  const appended = await appendDocBlocks(resolved.objToken, blocks);
  return { appended, objToken: resolved.objToken, objType: resolved.objType };
}

module.exports = { archiveLocal, buildDocBlocks, archiveToDoc, archiveToBitable, resolveDocToken, resolveArchiveFields, weekNumberOf, textBlock, headingBlock, appendDocBlocks };
