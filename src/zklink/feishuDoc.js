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
    textBlock(`口径：按人按上海挂钟日聚合，单日 ≥2 条打卡记「末卡 − 首卡」为当日时长，恰 1 条记 0（孤条），周合计。`),
    textBlock(`合计：打卡 ${agg.totals.punches} 条 · 总时长 ${report.fmtDuration(agg.totals.totalMs)} · 涉及 ${agg.totals.users} 人（有打卡 ${agg.totals.punchUsers} 人） · 孤条 ${agg.totals.lonelyDays} 天`),
    headingBlock(3, '本周汇总'),
  ];
  for (const u of agg.users) {
    const lonely = u.lonelyDays ? ` · 孤条 ${u.lonelyDays} 天` : '';
    blocks.push(textBlock(`• ${u.name}（${u.userid}）：${u.punchDays} 天 · ${report.fmtDuration(u.totalMs)}${lonely}`));
  }
  blocks.push(headingBlock(3, `打卡明细（全部 ${records.length} 条记录）`));
  for (const r of records) {
    const name = (agg.userNames && agg.userNames.get(r.userid)) || r._name || r.userid;
    const meta = [r.checkin_type, r.exception_type && `异常:${r.exception_type}`, r.groupname].filter(Boolean).join(' · ');
    blocks.push(textBlock(`• ${report.fmtTime(r.checkin_time * 1000)} ${name}（${r.userid}）${meta ? ` — ${meta}` : ''}`));
  }
  if (!records.length) blocks.push(textBlock('• （本窗口无打卡记录）'));
  return blocks;
}

// 追加到云文档末尾（自动解析 wiki 节点）；返回追加块数
async function archiveToDoc(win, agg, records, extra = {}) {
  const resolved = await resolveDocToken(config.archiveDocToken);
  const blocks = buildDocBlocks(win, agg, records, extra);
  const appended = await appendDocBlocks(resolved.objToken, blocks);
  return { appended, objToken: resolved.objToken, objType: resolved.objType };
}

module.exports = { archiveLocal, buildDocBlocks, archiveToDoc, resolveDocToken, textBlock, headingBlock, appendDocBlocks };
