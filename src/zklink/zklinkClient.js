// ============================================================
// ZKLink 平台 HTTP 客户端（数据源 http：接口直拉）
//
// ⚠ 端点为候选值（2026-10-07 无凭据侦查结论）：zklink.zktecoiot.com 是
// qiankun 微前端壳（webpackJsonpzlink_pc_cn_front），考勤模块 zkbio_att
// （ZKBio CloudTime）从 cloudtime.zktecoip.com 动态挂载，鉴权为 OAuth2
// Bearer access_token 指纹；但登录/拉数真实路径无法在无凭据下验证
// （GET 全被 SPA 兜底 HTML 接住，POST 被 nginx 405 拦）。
// 凭据到位后跑 node scripts/zklink-probe.js 校准，回填 .env 的
// ZKLINK_LOGIN_PATH / ZKLINK_TRANSACTION_PATH，再切 ZKLINK_DATA_SOURCE=http。
// 所有响应解析都按多候选形态容错（{access_token} / {data:{access_token}} /
// {data:{records|list|rows}}），校准后如仍有出入只改本文件。
// ============================================================
const config = require('./config');

let tokenCache = { token: '', expiresAt: 0 };

function isConfigured() {
  return !!(config.zklinkAccessToken || (config.zklinkUsername && config.zklinkPassword));
}

function noConfig() {
  const err = new Error('未配置 ZKLINK_ACCESS_TOKEN（飞书 SSO 账号贴 token）或 ZKLINK_USERNAME/PASSWORD（账密候选），http 数据源不可用');
  err.errcode = 'NO_CONFIG';
  err.hint = '飞书 SSO 登录的账号：浏览器登录 ZKLink 后 F12 抠 access_token 填 ZKLINK_ACCESS_TOKEN；有独立账号密码才跑 node scripts/zklink-probe.js 校准';
  return err;
}

// 从各类候选响应形态里抠 access_token
function extractToken(j) {
  if (!j || typeof j !== 'object') return '';
  return j.access_token || (j.data && (j.data.access_token || j.data.token)) || j.token || '';
}

async function login() {
  if (!isConfigured()) throw noConfig();
  // 静态 token 模式：跳过登录端点直接用（飞书 SSO 账号的唯一可行路径；过期由
  // fetchTransactions 的 HTTP 错误暴露 → 周报失败告警提醒再贴）
  if (config.zklinkAccessToken) return config.zklinkAccessToken;
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) return tokenCache.token;
  const res = await fetch(config.zklinkBaseUrl + config.zklinkLoginPath, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.zklinkUsername, password: config.zklinkPassword }),
  });
  const j = await res.json().catch(() => null);
  const token = extractToken(j);
  if (!token) {
    const err = new Error(`ZKLink 登录失败：HTTP ${res.status}，响应 ${JSON.stringify(j).slice(0, 200)}`);
    err.hint = '登录端点/凭据形态待校准（scripts/zklink-probe.js）';
    throw err;
  }
  // 平台未返回过期时间时按 2h 保守缓存（探明真实字段后可精确化）
  const expiresIn = (j && (j.expires_in || (j.data && j.data.expires_in))) || 7200;
  tokenCache = { token, expiresAt: Date.now() + Number(expiresIn) * 1000 };
  return token;
}

// 任意值 → 纪元毫秒：秒/毫秒时间戳、ISO 字符串、"YYYY-MM-DD HH:mm:ss"（按上海挂钟）
function toEpochMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // 秒 vs 毫秒
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600 * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// 任意平台记录对象 → 统一记录流（字段名按多候选容错）
function normalizeRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const name = item.name || item.personName || item.empName || item.userName || '';
  const userid = item.userid || item.userId || item.empNo || item.empID || item.personCode || item.pin || name;
  const ms = toEpochMs(item.punchTime || item.transactionTime || item.checkTime || item.time || item.punch_time);
  if (!userid || !ms) return null;
  return {
    userid: String(userid),
    _name: String(name || userid),
    checkin_time: Math.floor(ms / 1000),
    checkin_type: String(item.punchState || item.checkin_type || item.direction || ''),
    exception_type: String(item.exception || item.exception_type || ''),
    location_title: String(item.deviceName || item.location_title || item.sn || ''),
    wifiname: String(item.wifiname || ''),
    groupname: String(item.attGroupName || item.groupname || ''),
  };
}

// 从候选响应形态抠记录数组
function extractRecords(j) {
  if (!j || typeof j !== 'object') return [];
  const d = j.data && typeof j.data === 'object' ? j.data : j;
  const list = d.records || d.list || d.rows || d.transactions || (Array.isArray(j) ? j : null);
  return Array.isArray(list) ? list : [];
}

/**
 * 拉取窗口 [startMs, endMs) 内的打卡记录（统一记录流）
 * begin/end 参数名与格式为候选（YYYY-MM-DD HH:mm:ss 上海挂钟），probe 校准后可调。
 */
async function fetchTransactions(startMs, endMs) {
  const token = await login();
  const fmt = (ms) => {
    const d = new Date(ms + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  };
  const qs = new URLSearchParams({
    beginDate: fmt(startMs),
    endDate: fmt(endMs),
    page: '1',
    pageSize: '5000',
  });
  if (config.zklinkAttGroupId) qs.set('attGroupId', config.zklinkAttGroupId);
  const res = await fetch(`${config.zklinkBaseUrl}${config.zklinkTransactionPath}?${qs}`, {
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json().catch(() => null);
  if (res.status !== 200) {
    const err = new Error(`ZKLink 拉数失败：HTTP ${res.status}，响应 ${JSON.stringify(j).slice(0, 200)}`);
    err.hint = '拉数端点/参数待校准（scripts/zklink-probe.js）';
    throw err;
  }
  const records = extractRecords(j).map(normalizeRecord).filter(Boolean);
  return { records, raw: j };
}

module.exports = { isConfigured, login, fetchTransactions, extractToken, extractRecords, normalizeRecord, toEpochMs };
