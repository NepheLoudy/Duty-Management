/**
 * 离线桩测试 · ZKLink 周报云文档归档门控（runWeekly 级，2026-10-10 回归）：
 *   service.runWeekly 的门控此前误写 config.feishuAppConfigured（zklink config 只导出
 *   appConfigured）恒 undefined → 云文档留档通道永远 skipped，即使 APP_ID/SECRET 与
 *   ZKLINK_ARCHIVE_DOC_TOKEN 全部配好也不归档，且水位照常推进掩盖事实（v48c 漏网，
 *   模块级 archiver 测试测不到这个门控）。验证：
 *     ①关门（appConfigured=false）：archiveToDoc 不被调用，archived='skipped'；
 *     ②开门（appConfigured=true + docToken）：archiveToDoc 恰好一次，archived=true，
 *       webhook 周报卡照发，水位推进。
 * 外部依赖走桩（webhook/feishuDoc/card/store 模块级替换）；config 在 require 时固化
 * env，因此关门/开门两种装载态各起一个进程（本文件自 spawn 自身切换）。
 * 用法：node scripts/stub-test-zklink-archive.js [--open]
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const OPEN_MODE = process.argv.includes('--open');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zklink-archive-test-'));
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

// config 在 require 时固化 env：关门态显式置空（dotenv 不覆盖已存在键）
process.env.APP_ID = OPEN_MODE ? 'cli_stub' : '';
process.env.APP_SECRET = OPEN_MODE ? 'secret_stub' : '';
process.env.ZKLINK_ARCHIVE_DOC_TOKEN = 'docTokenStub';
process.env.ZKLINK_DATA_SOURCE = 'import';
process.env.ZKLINK_WEBHOOK_URL = 'https://open.feishu.cn/stub-webhook';
process.env.ZKLINK_STATE_FILE = path.join(TMP, 'zklink-state.json');
process.env.ZKLINK_EXPORTS_DIR = path.join(TMP, 'exports');
process.env.ZKLINK_ARCHIVE_DIR = path.join(TMP, 'archive');

// ---- 模块级桩 ----
const calls = { archiveToDoc: 0, archiveLocal: 0, webhook: 0 };
let storeState = {};
const stubs = {
  [path.join(ROOT, 'src/feishu/webhook.js')]: {
    sendCardToWebhook: async () => { calls.webhook++; return { code: 0 }; },
  },
  [path.join(ROOT, 'src/zklink/feishuDoc.js')]: {
    archiveLocal: () => { calls.archiveLocal++; },
    archiveToDoc: async () => { calls.archiveToDoc++; return { appended: 3, objType: 'docx' }; },
  },
  [path.join(ROOT, 'src/zklink/card.js')]: {
    buildWeeklyCard: () => ({ stub: 'weekly-card' }),
  },
  [path.join(ROOT, 'src/zklink/store.js')]: {
    loadMembers: () => [],
    loadState: () => JSON.parse(JSON.stringify(storeState)),
    mergeSaveState: (patch) => { storeState = { ...storeState, ...patch }; },
    saveState: (s) => { storeState = s; },
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith('.') && parent?.filename) {
    const abs = path.resolve(path.dirname(parent.filename), request);
    for (const key of Object.keys(stubs)) {
      if (abs === key || abs === key.replace(/\.js$/, '')) return key;
    }
  }
  return origResolve.call(this, request, parent, ...rest);
};
for (const [key, value] of Object.entries(stubs)) {
  require.cache[key] = new Module(key, null);
  require.cache[key].exports = value;
  require.cache[key].loaded = true;
}

const report = require(path.join(ROOT, 'src/zklink/report'));
const service = require(path.join(ROOT, 'src/zklink/service'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

(async () => {
  // 导入记录覆盖本播报窗口（窗口=上个周一锚定的 7 天）
  const win = report.weekWindow(0, Date.now(), 1);
  const inWin = [
    { userid: 'zhangsan', _name: '张三', checkin_time: sec(new Date(win.start + 9 * 3600 * 1000).toISOString()) },
    { userid: 'zhangsan', _name: '张三', checkin_time: sec(new Date(win.start + 18 * 3600 * 1000).toISOString()) },
  ];
  storeState = { imported: { records: inWin, importedAt: new Date().toISOString(), days: '7' } };

  const r = await service.runWeekly({ offset: 0, trigger: 'stub' });
  check('周报发送成功（sent=true）', r.sent === true);

  if (!OPEN_MODE) {
    console.log('\n== 关门态：appConfigured=false → 云文档留档 skipped ==');
    check('archiveToDoc 未被调用（门控不再被错误变量名恒短路）', calls.archiveToDoc === 0, String(calls.archiveToDoc));
    check('delivery.archived=skipped（本地 archive/ 兜底口径）', storeState.delivery && storeState.delivery.archived === 'skipped', JSON.stringify(storeState.delivery));
  } else {
    console.log('\n== 开门态：appConfigured=true + docToken → 云文档留档执行 ==');
    check('archiveToDoc 恰好被调用一次', calls.archiveToDoc === 1, String(calls.archiveToDoc));
    check('delivery.archived=true（留档完成入水位）', storeState.delivery && storeState.delivery.archived === true, JSON.stringify(storeState.delivery));
    check('webhook 周报卡照发', calls.webhook === 1, String(calls.webhook));
    check('水位推进 lastArchivedWeekKey=本周键', storeState.lastArchivedWeekKey === win.key, `${storeState.lastArchivedWeekKey} vs ${win.key}`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果（${OPEN_MODE ? '开门' : '关门'}态）：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('桩测试异常:', e); process.exit(1); });
