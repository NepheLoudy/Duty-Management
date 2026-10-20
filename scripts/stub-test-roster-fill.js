// 梯队评价表考勤时长回填插件桩测试（mock fetch，不出网）
// 覆盖：组序号映射 / open_id 优先+姓名兜底 / 只写时长列 / dry-run 不写 / 覆盖与跳过
// 运行：npm run test:roster-fill（接入 push.js 部署闸门）
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-roster-fill-'));
process.env.ZKLINK_DATA_DIR = TMP;
process.env.ROSTER_FILL_ENABLED = '1';
process.env.ROSTER_FILL_APP_TOKEN = 'app-test';
process.env.ROSTER_FILL_TABLE_ID = 'tbl-test';
process.env.ROSTER_FILL_FIELD_MEMBER = '梯队队员';
process.env.ROSTER_FILL_FIELD_DURATION = '考勤时长';
process.env.ROSTER_FILL_FIELD_PERIOD = '时段';
process.env.ROSTER_FILL_FIRST_WEEK_START = '2026-10-12';
process.env.ROSTER_FILL_CRON = '40 9 * * 1';
process.env.ROSTER_FILL_OVERWRITE = '1';

const sec = (s) => Math.floor(Date.parse(s) / 1000);
const sessions = [
  { userid: 'u1', _name: '甲', day: '2026-10-12', checkin_time: sec('2026-10-12T09:00:00+08:00'), checkout_time: sec('2026-10-12T19:00:00+08:00'), durationMs: 10 * 3600000, complete: true, missing: false },
  { userid: 'u2', _name: '乙', day: '2026-10-12', checkin_time: sec('2026-10-12T10:00:00+08:00'), checkout_time: sec('2026-10-12T16:30:00+08:00'), durationMs: 6.5 * 3600000, complete: true, missing: false },
];
require.cache[require.resolve('../src/zklink/feishuAttendance')] = {
  id: 'att-stub', filename: 'att-stub', loaded: true,
  exports: {
    async fetchTaskSessions() { return { sessions, userCount: 2, invalidUserIds: [], unauthorizedUserIds: [] }; },
    async resolveGroupMembers() {
      return { members: [{ userid: 'u1', name: '甲', openId: 'ou_1' }, { userid: 'u2', name: '乙', openId: 'ou_2' }], group: { groupId: 'g', groupName: 'g' } };
    },
    async listUsersWithUserId() { return []; },
  },
};
require.cache[require.resolve('../src/feishu/client')] = {
  id: 'client-stub', filename: 'client-stub', loaded: true,
  exports: { async getTenantAccessToken() { return 't-test'; } },
};

const plugin = require('../src/plugins/rosterFill');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}

const fields = [
  { field_name: '梯队队员', type: 11, property: { multiple: false } },
  { field_name: '考勤时长', type: 2, property: { formatter: '0.0' } },
  { field_name: '时段', type: 3, property: { options: [
    { id: 'o1', name: 'Week5' },
    { id: 'o2', name: 'week6' },
    { id: 'o3', name: 'week7' },
  ] } },
];
const records = [
  { record_id: 'r1', fields: { 梯队队员: [{ id: 'ou_1', name: '甲' }], 考勤时长: null, 时段: 'Week5' } },
  { record_id: 'r2', fields: { 梯队队员: [{ id: 'ou_2', name: '乙' }], 考勤时长: 9.9, 时段: 'Week5' } },
  { record_id: 'r3', fields: { 梯队队员: [{ id: 'ou_x', name: '丙' }], 考勤时长: null, 时段: 'Week5' } },
  { record_id: 'r4', fields: { 梯队队员: [{ id: 'ou_1', name: '甲' }], 考勤时长: null, 时段: 'week6' } },
  { record_id: 'r5', fields: { 梯队队员: [{ id: 'ou_2', name: '乙' }], 考勤时长: null, 时段: 'week6' } },
  { record_id: 'r6', fields: { 梯队队员: [{ id: 'ou_1', name: '甲' }], 考勤时长: null, 时段: 'week7' } },
];
let batchBodies = [];
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/fields?page_size=100')) return { json: async () => ({ code: 0, data: { items: fields } }) };
  if (u.includes('/records?page_size=100')) return { json: async () => ({ code: 0, data: { items: records, has_more: false } }) };
  if (u.includes('/records/batch_update')) {
    const body = JSON.parse(init.body);
    batchBodies.push(body);
    return { json: async () => ({ code: 0, data: { records: body.records } }) };
  }
  return { json: async () => ({ code: 1, msg: `unexpected ${u}` }) };
};

(async () => {
  console.log('\n== 1. 组序号 / 上一周 映射 ==');
  check('10-12 → 第 0 组', plugin.resolveGroupIndex('2026-10-12') === 0);
  check('10-19 → 第 1 组', plugin.resolveGroupIndex('2026-10-19') === 1);
  check('10-26 → 第 2 组', plugin.resolveGroupIndex('2026-10-26') === 2);
  check('周二 10-20 的上一周=10-12', plugin.previousWeekStart(new Date('2026-10-20T23:16:00+08:00')) === '2026-10-12');
  check('周一 10-26 的上一周=10-19', plugin.previousWeekStart(new Date('2026-10-26T09:40:00+08:00')) === '2026-10-19');
  let overflow = null;
  try { await plugin.fillWeek({ weekStartStr: '2026-11-02', dryRun: true }); } catch (e) { overflow = e; }
  check('11-02 → 第 3 组超出表内 3 组，报错', overflow && String(overflow.message).includes('超出表内时段范围'), String(overflow));

  console.log('\n== 2. 第一组 dry-run：不写表、只匹配、只算时长列 ==');
  batchBodies = [];
  const dry = await plugin.fillWeek({ weekStartStr: '2026-10-12', dryRun: true });
  check('第一组=Week5', dry.groupIndex === 0 && dry.period === 'Week5', JSON.stringify(dry));
  check('匹配 2 人、未匹配 1 人（ou_x）', dry.matched === 2 && dry.unmatched.length === 1 && dry.unmatched[0].name === '丙', JSON.stringify(dry.unmatched));
  check('时长=10h / 6.5h', dry.plan.find((p) => p.name === '甲').hours === 10 && dry.plan.find((p) => p.name === '乙').hours === 6.5, JSON.stringify(dry.plan));
  check('dry-run 不调用 batch_update', batchBodies.length === 0, JSON.stringify(batchBodies));

  console.log('\n== 3. 正式写入：覆盖旧值 / 只写考勤时长 ==');
  batchBodies = [];
  const full = await plugin.fillWeek({ weekStartStr: '2026-10-12', dryRun: false, overwrite: true });
  check('写入 2 条', full.updated === 2 && batchBodies.length === 1 && batchBodies[0].records.length === 2, JSON.stringify(batchBodies));
  const byRec = new Map(batchBodies[0].records.map((r) => [r.record_id, r.fields]));
  check('甲 r1=10h / 乙 r2=6.5h（覆盖 9.9）', byRec.get('r1')['考勤时长'] === 10 && byRec.get('r2')['考勤时长'] === 6.5, JSON.stringify([...byRec]));
  check('更新体只含考勤时长字段', [...byRec.values()].every((f) => Object.keys(f).join(',') === '考勤时长'), JSON.stringify([...byRec]));

  console.log('\n== 4. --no-overwrite：已有值跳过 ==');
  batchBodies = [];
  const noOver = await plugin.fillWeek({ weekStartStr: '2026-10-12', dryRun: false, overwrite: false });
  check('跳过乙（9.9）/ 只写甲', noOver.skipped.length === 1 && noOver.skipped[0].name === '乙' && noOver.updated === 1, JSON.stringify(noOver));
  check('batch_update 只含 r1', batchBodies[0].records.length === 1 && batchBodies[0].records[0].record_id === 'r1', JSON.stringify(batchBodies));

  console.log('\n== 5. 第二组映射 ==');
  const second = await plugin.fillWeek({ weekStartStr: '2026-10-19', dryRun: true });
  check('第二组=week6 / 2 人匹配', second.groupIndex === 1 && second.period === 'week6' && second.matched === 2, JSON.stringify(second));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
