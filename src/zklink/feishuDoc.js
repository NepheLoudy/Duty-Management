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
// 只见 13 人且部门接口 99992357——2026-10-12 实测）。部门发现走 children 路径式接口：
// 根部门 users 列表恒为空，靠用户 department_ids 反向发现拉不到人（2026-10-26 修复）。
async function fetchOpenIdMap() {
  const token = await getTenantAccessToken();
  const map = {};
  const depts = ['0'];
  const seen = new Set(['dept:0']);
  while (depts.length) {
    const d = depts.shift();
    let pageToken = '';
    do {
      const qs = new URLSearchParams({ department_id: d, department_id_type: 'department_id', user_id_type: 'user_id', page_size: '50' });
      if (pageToken) qs.set('page_token', pageToken);
      const res = await fetch(`${OPEN_API}/contact/v3/users?${qs}`, {
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (j.code !== 0) { console.warn(`[打卡留档] 通讯录部门 ${d} 拉取失败（${j.code} ${j.msg || ''}），跳过`); break; }
      for (const p of (j.data && j.data.items) || []) {
        if (p.user_id && p.open_id && !map[p.user_id]) map[p.user_id] = p.open_id;
        for (const dd of (p.department_ids || [])) if (!seen.has('dept:' + dd)) { seen.add('dept:' + dd); depts.push(dd); }
      }
      pageToken = (j.data && j.data.page_token) || '';
    } while (pageToken);
    try {
      const cr = await fetch(`${OPEN_API}/contact/v3/departments/${encodeURIComponent(d)}/children?department_id_type=department_id&user_id_type=user_id&page_size=50`, {
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}` },
      });
      const cj = await cr.json();
      for (const cd of ((cj.data && cj.data.items) || [])) {
        if (cd.department_id && !seen.has('dept:' + cd.department_id)) { seen.add('dept:' + cd.department_id); depts.push(cd.department_id); }
      }
    } catch (e) { /* 子部门发现失败不阻塞 */ }
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
// 2026-10-26 起整周跳过改为按人 upsert（见 archiveToBitable）：名单修正后也要能补人。
async function listRecordsPaged(appToken, tableId) {
  const items = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({ page_size: '500' });
    if (pageToken) qs.set('page_token', pageToken);
    const data = await bitableCall(appToken, `${tableId}/records?${qs}`);
    items.push(...(data.items || []));
    pageToken = data.has_more ? (data.page_token || '') : '';
  } while (pageToken);
  return items;
}

// 人员列取值（bitable User 字段返回 [{id,name,en_name,email}]）
function personCell(fields, fieldName) {
  const arr = fields && Array.isArray(fields[fieldName]) ? fields[fieldName] : [];
  const first = arr[0] || {};
  return { id: first.id ? String(first.id) : '', name: first.name || first.en_name || '' };
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
  const weekField = fields.week ? fields.week.field_name : '';
  const userField = fields.user.field_name;
  const durField = fields.duration.field_name;

  // 同周已有行按人比对（2026-10-26 曼波定）：原「同周有行即整周跳过」让名单修正无法补写
  //（第 7 周 70 行缺 2 人实锤）。现在按人员列 open_id（无则姓名）幂等 upsert：
  // 缺的人补建、时长/及格变化的行批量更新，其余不动。
  const existing = weekNum == null || !weekField
    ? []
    : (await listRecordsPaged(appToken, tableId)).filter((r) => Number(r.fields && r.fields[weekField]) === weekNum);
  const byOpenId = new Map();
  const byName = new Map();
  for (const r of existing) {
    const p = personCell(r.fields, userField);
    if (p.id && !byOpenId.has(p.id)) byOpenId.set(p.id, r);
    if (p.name && !byName.has(p.name)) byName.set(p.name, r);
  }

  const openIdMap = await fetchOpenIdMap(); // 名单不带 openId 时的兜底映射
  const creates = [];
  const updates = [];
  const noOpenId = [];
  for (const u of agg.users) {
    const oid = u.openId || openIdMap[u.userid] || '';
    if (!oid) noOpenId.push(u.name);
    const fieldsBody = {};
    if (oid) fieldsBody[userField] = [{ id: oid }];
    fieldsBody[durField] = report.fmtDuration(u.totalMs);
    if (fields.pass && config.passHours > 0) fieldsBody[fields.pass.field_name] = u.totalMs >= config.passHours * 3600 * 1000;
    if (weekField && weekNum != null) fieldsBody[weekField] = weekNum;

    const hit = (oid && byOpenId.get(oid)) || byName.get(u.name) || null;
    if (!hit) { creates.push({ fields: fieldsBody }); continue; }
    const patch = {};
    if (String((hit.fields || {})[durField] || '') !== fieldsBody[durField]) patch[durField] = fieldsBody[durField];
    if (fields.pass && config.passHours > 0 && (hit.fields || {})[fields.pass.field_name] !== fieldsBody[fields.pass.field_name]) {
      patch[fields.pass.field_name] = fieldsBody[fields.pass.field_name];
    }
    const hp = personCell(hit.fields, userField);
    if (oid && !hp.id) patch[userField] = [{ id: oid }]; // 老行人员列留空（可见范围外）→ 补全
    if (Object.keys(patch).length) updates.push({ record_id: hit.record_id, fields: patch });
  }
  if (noOpenId.length) console.warn(`[打卡留档] ${noOpenId.length} 人不在通讯录可见范围、人员列留空：${noOpenId.join('、')}（名单源修复后可重置归档水位补全）`);

  for (let i = 0; i < creates.length; i += 500) {
    await bitableCall(appToken, `${tableId}/records/batch_create`, {
      method: 'POST',
      body: JSON.stringify({ records: creates.slice(i, i + 500) }),
    });
  }
  for (let i = 0; i < updates.length; i += 500) {
    await bitableCall(appToken, `${tableId}/records/batch_update`, {
      method: 'POST',
      body: JSON.stringify({ records: updates.slice(i, i + 500) }),
    });
  }
  if (!creates.length && !updates.length) console.log(`[打卡留档] 第 ${weekNum} 周 ${existing.length} 行已是最新，无写入`);
  return { appended: creates.length, updated: updates.length, tableId, skipped: !creates.length && !updates.length };
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

// 云文档块序列：heading2 周标题节 + 口径/汇总 + 每人一行 + 全部班段/打卡记录逐条
function buildDocBlocks(win, agg, records, extra = {}) {
  const mode = agg.mode || 'pairs';
  const totals = agg.totals;
  const ruleLine = mode === 'sessions'
    ? '口径：按飞书考勤平台上下班配对（工作日 06:00–次日 05:59 切天，跨天班次计入起始日）；单边卡标缺卡、不计时长；名单内未打卡者 0 时长呈现。'
    : '口径：按人按上海挂钟日聚合，当日打卡按顺序两两配对（1→2、3→4…）记「段末−段首」之和；奇数张末张落单不计（落单卡），跨天相邻卡不配对，恰 1 条记 0（孤条）。';
  const summaryLine = mode === 'sessions'
    ? `合计：有效班次 ${totals.completeSessions} 段 · 总时长 ${report.fmtDuration(totals.totalMs)} · 涉及 ${totals.users} 人（有打卡 ${totals.punchUsers} 人）${totals.missingSessions ? ` · 缺卡 ${totals.missingSessions} 段` : ''}`
    : `合计：打卡 ${totals.punches} 条 · 总时长 ${report.fmtDuration(totals.totalMs)} · 涉及 ${totals.users} 人（有打卡 ${totals.punchUsers} 人）${totals.lonelyDays ? ` · 孤条 ${totals.lonelyDays} 天` : ''}${totals.leftoverCards ? ` · 落单 ${totals.leftoverCards} 卡` : ''}`;
  const blocks = [
    headingBlock(2, `⏱ 打卡时长周报（${win.label}）`),
    textBlock(`生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')} · 数据源：${extra.dataSource || config.dataSource}（ZKLink 云考勤${extra.groupLabel ? ` · 考勤组：${extra.groupLabel}` : ''}）`),
    textBlock(ruleLine),
    textBlock(summaryLine),
    headingBlock(3, '本周汇总'),
  ];
  for (const u of agg.users) {
    const extraLine = mode === 'sessions'
      ? (u.missingSessions ? ` · 缺卡 ${u.missingSessions} 段` : '')
      : (u.lonelyDays ? ` · 孤条 ${u.lonelyDays} 天` : '');
    blocks.push(textBlock(`• ${u.name}（${u.userid}）：${u.punchDays} 天 · ${report.fmtDuration(u.totalMs)}${extraLine}`));
  }
  blocks.push(headingBlock(3, `打卡明细（全部 ${records.length} ${mode === 'sessions' ? '个班段' : '条记录'}）`));
  for (const r of records) {
    const mi = (agg.userNames && agg.userNames.get(r.userid)) || null; // memberMap：{name, openId}
    const name = (mi && mi.name) || r._name || r.userid;
    if (mode === 'sessions') {
      const range = r.checkin_time && r.checkout_time
        ? `${report.fmtTime(r.checkin_time * 1000)}→${report.fmtTime(r.checkout_time * 1000)}`
        : r.checkin_time
          ? `${report.fmtTime(r.checkin_time * 1000)}→缺下班`
          : r.checkout_time
            ? `缺上班→${report.fmtTime(r.checkout_time * 1000)}`
            : '无记录';
      const status = r.complete ? report.fmtDuration(r.durationMs) : (r.missing ? '缺卡' : '无需下班卡');
      const meta = [r.day, status].filter(Boolean).join(' · ');
      blocks.push(textBlock(`• ${range} ${name}（${r.userid}）${meta ? ` — ${meta}` : ''}`));
      continue;
    }
    const meta = [r.checkin_type, r.exception_type && `异常:${r.exception_type}`, r.groupname].filter(Boolean).join(' · ');
    blocks.push(textBlock(`• ${report.fmtTime(r.checkin_time * 1000)} ${name}（${r.userid}）${meta ? ` — ${meta}` : ''}`));
  }
  if (!records.length) blocks.push(textBlock('• （本窗口无打卡记录）'));
  return blocks;
}

/** 留档链接（v63：播报卡只发链接，明细在按周留档里）——wiki 节点链接，队员点开即达 */
function archiveLink() {
  if (!config.archiveDocToken) return '';
  const base = config.archiveLinkBase || 'https://cquqianli.feishu.cn';
  return `${base}/wiki/${config.archiveDocToken}`;
}

// 追加到云文档末尾（自动解析 wiki 节点）；返回追加块数。
// objType=bitable 时走多维表格归档（2026-10-12 曼波定：归档落点=「打卡记录」bitable，
// 按人每周一行——docx 分支从未成功落档过，bitable 是首个真归档形态）。
async function archiveToDoc(win, agg, records, extra = {}) {
  const resolved = await resolveDocToken(config.archiveDocToken);
  if (resolved.objType === 'bitable') {
    const r = await archiveToBitable(win, agg, resolved.objToken);
    return { appended: r.appended, updated: r.updated || 0, objToken: resolved.objToken, objType: resolved.objType, tableId: r.tableId, skipped: !!r.skipped };
  }
  const blocks = buildDocBlocks(win, agg, records, extra);
  const appended = await appendDocBlocks(resolved.objToken, blocks);
  return { appended, objToken: resolved.objToken, objType: resolved.objType };
}

module.exports = { archiveLocal, buildDocBlocks, archiveToDoc, archiveToBitable, resolveDocToken, resolveArchiveFields, weekNumberOf, archiveLink, textBlock, headingBlock, appendDocBlocks };
