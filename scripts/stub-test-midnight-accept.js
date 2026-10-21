// 值日验收跨零点桩测试（2026-10-22 曼波改：收口 24:00 → 值日次日凌晨 04:00）
// 覆盖：会话日期守卫按值日业务日（dutyDateStr）判定——凌晨 00:00–04:00 的打卡/照片
// 还算值日当天；过期会话仍清理；收口归属与配置默认值。
// 手法：冻结假时钟（上海 2026-10-23 00:30），require.cache 注入 utils/dates 桩后再加载服务。
// 运行：npm run test:midnight-accept（接入 push.js 部署闸门）
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-midnight-'));
process.env.PLAZA_BITABLE_TABLE_ID = '';
process.env.QUIET_HOURS_DISABLED = '1';
process.env.DUTY_STATE_FILE = path.join(TMP, 'state.json');
process.env.DUTY_MEMBERS_FILE = path.join(TMP, 'members.json');
process.env.DUTY_WHITELIST_FILE = path.join(TMP, 'whitelist.json');
fs.writeFileSync(process.env.DUTY_MEMBERS_FILE, JSON.stringify({
  members: [{ name: '队员A', openId: 'ou_a', admin: true }],
}));
fs.writeFileSync(process.env.DUTY_WHITELIST_FILE, JSON.stringify({ names: [] }));

// ---- 假时钟：上海 2026-10-23 00:30（值日日 10-22 的验收窗内） ----
const REAL_TODAY = '2026-10-23'; // 上海挂钟今天（已跨零点）
const FAKE_NOW_MS = Date.parse('2026-10-22T16:30:00Z'); // = 上海 10-23 00:30
const DUTY_DAY = '2026-10-22'; // 值日业务日（收口归属口径 <06:00 → 前一日）

// 先加载真实 dates 模块，再以「仅冻结时间函数」的桩覆盖（addDays 等纯函数原样复用）
const realDates = require('../src/utils/dates');
require.cache[require.resolve('../src/utils/dates')] = {
  id: 'dates-stub', filename: 'dates-stub', loaded: true,
  exports: {
    ...realDates,
    shanghaiParts: (input) => realDates.shanghaiParts(input == null ? FAKE_NOW_MS : input),
    todayStr: () => REAL_TODAY,
    dutyDateStr: (input) => realDates.dutyDateStr(input == null ? FAKE_NOW_MS : input),
  },
};

// dutyTable 桩：内存记录（10-22 与 10-21 各一条），setStatus 留痕
const table = {
  '2026-10-22': [{ recordId: 'rec_duty', name: '队员A', position: '总负责', status: '', receiptCounts: { '总负责': 0, '工位区': 0, '装配区': 0 }, dayStatus: '' }],
  '2026-10-21': [{ recordId: 'rec_old', name: '队员A', position: '工位区', status: '', receiptCounts: { '总负责': 0, '工位区': 0, '装配区': 0 }, dayStatus: '' }],
};
const statusWrites = [];
require.cache[require.resolve('../src/services/dutyTableService')] = {
  id: 'dutytable-stub', filename: 'dutytable-stub', loaded: true,
  exports: {
    async getRecordsByDate(date) { return (table[date] || []).map((r) => ({ ...r, receiptCounts: { ...r.receiptCounts } })); },
    async getAllDayRecords() { return Object.entries(table).flatMap(([d, rs]) => rs.map((r) => ({ ...r, dateStr: d }))); },
    async setStatus(recordId, status) { statusWrites.push({ recordId, status }); return {}; },
    async setDayStatus() { return {}; },
    async computeDayStatus() { return null; },
  },
};
require.cache[require.resolve('../src/feishu/bot')] = {
  id: 'bot-stub', filename: 'bot-stub', loaded: true,
  exports: {
    async sendTextToUser(openId, text) { (global.__dm = global.__dm || []).push({ openId, text }); return {}; },
    async sendTextToChat() { return {}; },
    async sendCardToChat() { return {}; },
  },
};

const inquiry = require('../src/services/inquiryService');
const state = require('../src/services/stateStore');
const config = require('../src/config');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}

(async () => {
  console.log('\n== 1. 配置默认值 ==');
  check('收口默认 04:00', config.schedule.deadline === '0 0 4 * * *', config.schedule.deadline);
  check('对账默认 04:30', config.schedule.reconcile === '0 30 4 * * *', config.schedule.reconcile);
  check('临门提醒保留 23:00', config.schedule.lastCall === '0 0 23 * * *', config.schedule.lastCall);
  check('dutyDateStr(00:30) = 前一日', realDates.dutyDateStr(FAKE_NOW_MS) === DUTY_DAY, realDates.dutyDateStr(FAKE_NOW_MS));
  check('dutyDateStr(白天) = 当天', realDates.dutyDateStr(Date.parse('2026-10-22T03:00:00Z')) === '2026-10-22'); // 上海 11:00

  console.log('\n== 2. 凌晨 00:30 打卡：跨零点会话仍算值日当天 ==');
  state.mutate((s) => {
    s.sessions['ou_a'] = { date: DUTY_DAY, recordId: 'rec_duty', name: '队员A', position: '总负责', askedAt: new Date().toISOString() };
  });
  const yes = await inquiry.handleYes('ou_a');
  check('00:30 回「打卡」→ 置已做完（会话不因跨零点失效）', yes.handled && statusWrites.some((w) => w.recordId === 'rec_duty' && w.status === '已做完'), JSON.stringify({ yes, statusWrites }));

  console.log('\n== 3. 过期会话仍清理 ==');
  state.mutate((s) => {
    s.sessions['ou_a'] = { date: '2026-10-20', recordId: 'rec_old', name: '队员A', position: '工位区', askedAt: new Date().toISOString() };
  });
  const stale = await inquiry.handleYes('ou_a');
  check('两天前的会话 → 不认并清理', stale.handled === false && !state.load().sessions['ou_a'], JSON.stringify(stale));

  console.log('\n== 4. 收口归属与状态 ==');
  state.mutate((s) => {
    s.sessions['ou_a'] = { date: DUTY_DAY, recordId: 'rec_duty', name: '队员A', position: '总负责', askedAt: new Date().toISOString() };
  });
  const closed = await inquiry.closeToday({ dateStr: DUTY_DAY });
  check('收口 10-22：空状态置未做完', closed.results.length === 1 && closed.results[0].status === '未做完', JSON.stringify(closed.results));
  check('收口：当日会话清空 + 水位=值日当天', Object.keys(state.load().sessions).length === 0 && state.load().lastCloseDate === DUTY_DAY, JSON.stringify(state.load().lastCloseDate));

  console.log('\n== 5. 临门提醒跨零点定位值日当天 ==');
  global.__dm = [];
  // 造回一条未完结记录供临门提醒扫描
  table[DUTY_DAY][0].status = '';
  const lc = await inquiry.sendLastCall({ dryRun: true });
  check('临门提醒查询的是值日业务日 10-22（非挂钟今天 10-23）', lc.date === DUTY_DAY && lc.sent.length === 1, JSON.stringify({ date: lc.date, sent: lc.sent }));
  check('临门提醒文案告知次日凌晨 4:00 验收', lc.sent[0].preview.includes('次日凌晨 4:00'), lc.sent[0].preview);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
