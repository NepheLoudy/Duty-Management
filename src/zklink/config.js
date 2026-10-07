// ============================================================
// ZKLink 打卡时长周报 · 域配置（2026-10-07 v48 并入 duty-bot，从独立仓归并）
//
// 复用面（曼波定「复用现有应用和分发以及触发逻辑」）：
//   - 应用身份（docx 留档）= duty-bot 现有 APP_ID/APP_SECRET（本文件不设新键）；
//   - 播报分发 = 值日看板同一条群 webhook（DUTY_BOARD_WEBHOOK_URL，曼波确认同一条），
//     ZKLINK_WEBHOOK_URL 可覆盖、ZKLINK_WEBHOOK_SECRET 机器人开签名校验才填；
//   - 触发/静默/积压/失败补报 = src/cron/index.js 的 gateTask 体系（本文件只出 cron 表达式）；
//   - 管理端点鉴权 = duty-bot 现有 API_TOKEN（src/auth.js）。
//
// cron 口径与 duty-bot 全仓一致：node-cron 6 段式（秒 分 时 日 月 周）；也兼容 5 段。
// ============================================================
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// 运行时数据目录默认在项目内（本地开发），部署目标 .env 指向项目外 duty-bot-data/zklink/
//（顶层 AGENTS「运行时数据保护」：状态文件不放项目内，防 push 覆盖/误删）
const DATA_DIR = process.env.ZKLINK_DATA_DIR || path.join(ROOT, 'zklink-data');

const config = {
  enabled: process.env.ZKLINK_DISABLED !== '1',
  dataSource: (process.env.ZKLINK_DATA_SOURCE || 'import') === 'http' ? 'http' : 'import',
  timezone: 'Asia/Shanghai',
  cron: process.env.ZKLINK_BROADCAST_CRON || '0 30 9 * * 1', // 周一 09:30 上海，播上一周

  zklinkBaseUrl: (process.env.ZKLINK_BASE_URL || 'https://zklink.zktecoiot.com').replace(/\/+$/, ''),
  zklinkUsername: process.env.ZKLINK_USERNAME || '',
  zklinkPassword: process.env.ZKLINK_PASSWORD || '',
  // 静态 token 模式（2026-10-07 曼波反馈：其 ZKLink 账号走飞书 SSO 登录，无独立密码，
  // 账密自动登录走不通）——浏览器登录后 F12 抠 access_token 填这里，机器人直接带它
  // 拉数；token 过期后周报失败告警提醒再贴一次。填了则优于此账密候选。
  zklinkAccessToken: process.env.ZKLINK_ACCESS_TOKEN || '',
  // 候选端点：zklink.zktecoiot.com 是 qiankun 微前端壳（考勤模块 zkbio_att 动态挂载），
  // 登录/拉数真实路径未经凭据验证——凭据到位后跑 scripts/stub-zklink-probe.js 校准回填
  zklinkLoginPath: process.env.ZKLINK_LOGIN_PATH || '/oauth/token',
  zklinkTransactionPath: process.env.ZKLINK_TRANSACTION_PATH || '/zkbio_att/api/attendance/transaction/list',
  zklinkAttGroupId: process.env.ZKLINK_ATT_GROUP_ID || '',

  // 播报：缺省回落值日看板同一条 webhook（复用分发）
  webhookUrl: process.env.ZKLINK_WEBHOOK_URL || process.env.DUTY_BOARD_WEBHOOK_URL || '',
  webhookSecret: process.env.ZKLINK_WEBHOOK_SECRET || '',

  // 云文档留档（应用身份复用 duty-bot 的 APP_ID/APP_SECRET，见 src/config.js feishu 段）
  appConfigured: !!(process.env.APP_ID && process.env.APP_SECRET),
  archiveDocToken: process.env.ZKLINK_ARCHIVE_DOC_TOKEN || '',

  stateFile: process.env.ZKLINK_STATE_FILE || path.join(DATA_DIR, 'zklink-state.json'),
  exportsDir: process.env.ZKLINK_EXPORTS_DIR || path.join(DATA_DIR, 'exports'),
  archiveDir: process.env.ZKLINK_ARCHIVE_DIR || path.join(DATA_DIR, 'archive'),
};

config.cronParts = parseCron(config.cron);

// 兼容 6 段（秒 分 时 日 月 周，duty-bot 全仓口径）与 5 段（分 时 日 月 周）；
// 解析不出回退周一 09:30。秒位忽略（补发判定只需 分/时/周几）。
function parseCron(expr) {
  const fallback = { minute: 30, hour: 9, dow: 1, parsed: false };
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5 && f.length !== 6) return fallback;
  const m = f.length === 6 ? 1 : 0; // 6 段时整体右移一位
  if (!/^\d{1,2}$/.test(f[m]) || !/^\d{1,2}$/.test(f[m + 1])) return fallback;
  if (f[m + 2] !== '*' || f[m + 3] !== '*') return fallback;
  if (f[m + 4] !== '*' && !/^\d{1,2}$/.test(f[m + 4])) return fallback;
  const minute = Number(f[m]);
  const hour = Number(f[m + 1]);
  const dow = f[m + 4] === '*' ? null : Number(f[m + 4]) % 7; // 0/7 都算周日
  if (minute > 59 || hour > 23) return fallback;
  return { minute, hour, dow, parsed: true };
}

module.exports = config;
