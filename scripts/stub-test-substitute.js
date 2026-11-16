// 代班指定桩测试（2026-11-16 v97）：requestSubstitute 双会话与私信 / confirmSubstitute
// 换人写表+补偿登记+回执 / rejectSubstitute 轮次流转 / 超时清扫 TTL 刷新 / cancelLeave 联动。
// 名册指向临时文件；bitable/私信全走 fetch 桩（不出网）。
// 运行：npm run test:substitute（接入 push.js 部署闸门）
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
process.env.DUTY_STATE_FILE = path.join(os.tmpdir(), `sub-state-${Date.now()}.json`);
process.env.DUTY_MEMBERS_FILE = path.join(ROOT, 'config', 'members.json'); // 先真路径，下面覆盖
const TMP_MEMBERS = path.join(os.tmpdir(), `sub-members-${Date.now()}.json`);
process.env.DUTY_MEMBERS_FILE = TMP_MEMBERS;
process.env.QUIET_HOURS_DISABLED = '1';

// 临时名册：李四（请假人）/ 王五（代班人）/ 赵六（第二轮代班人）
fs.writeFileSync(TMP_MEMBERS, JSON.stringify({ members: [
  { name: '李四', openId: 'ou_li', admin: true },
  { name: '王五', openId: 'ou_wang' },
  { name: '赵六', openId: 'ou_zhao' },
] }));

const state = require('../src/services/stateStore');
const substitute = require('../src/services/substituteService');
const dutyTable = require('../src/services/dutyTableService');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

const REC = { record_id: 'recDuty1', fields: { '姓名': '李四', '负责区域': '总负责', '值日时间': Date.parse('2026-11-20T00:00:00+08:00') } };
const REC_NORM = { recordId: 'recDuty1', name: '李四', openId: 'ou_li', dateStr: '2026-11-20', position: '总负责', status: '', dayStatus: '', receiptCounts: {} };
let privateMsgs = [];
let updatedFields = [];
let realFetch = null;

function installFetch() {
  realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj, headers: new Map() });
    if (u.includes('/auth/v3/tenant_access_token')) return json({ code: 0, tenant_access_token: 'T' });
    if (u.includes('/bitable/v1') && u.includes('/records') && !u.includes('batch') && opts.method === 'PUT') {
      updatedFields.push(JSON.parse(opts.body));
      return json({ code: 0, data: { record: { record_id: 'recDuty1', fields: {} } } });
    }
    if (u.includes('/bitable/v1') && u.includes('/records?')) {
      return json({ code: 0, data: { items: [REC], has_more: false } });
    }
    if (u.includes('/im/v1/messages')) {
      privateMsgs.push(JSON.parse(opts.body).content);
      return json({ code: 0, data: {} });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

function seedLeave(openId) {
  state.mutate((s) => {
    s.pendingLeaves = s.pendingLeaves || {};
    s.pendingLeaves[openId] = {
      recordId: 'recDuty1', dateStr: '2026-11-20', position: '总负责', name: '李四', askedAt: new Date().toISOString(),
    };
  });
}

(async () => {
  installFetch();

  console.log('== 1. requestSubstitute：双会话 + 私信代班人 ==');
  seedLeave('ou_li');
  const r1 = await substitute.requestSubstitute('ou_li', '王五');
  check('请假人回执=已通知代班', r1.reply.includes('已向 王五'));
  const s1 = state.load();
  check('pendingLeaves 带 substitute', s1.pendingLeaves['ou_li'].substitute && s1.pendingLeaves['ou_li'].substitute.name === '王五');
  check('pendingSubstitutes 建代班会话', s1.pendingSubstitutes['ou_wang'] && s1.pendingSubstitutes['ou_wang'].leaveName === '李四' && s1.pendingSubstitutes['ou_wang'].recordId === 'recDuty1');
  await new Promise((r) => setTimeout(r, 30));
  check('代班人收到私信', privateMsgs.some((m) => m.includes('指定你代班') && m.includes('确认代班')), JSON.stringify(privateMsgs));
  privateMsgs = [];

  console.log('== 2. requestSubstitute 拒绝面 ==');
  const bad = await substitute.requestSubstitute('ou_li', '查无此人');
  check('名册未命中 → 提示重试', bad.reply.includes('查不到'));
  const self = await substitute.requestSubstitute('ou_li', '李四');
  check('指定自己 → 拒绝', self.reply.includes('不能指定你自己'));
  seedLeave('ou_zhao');
  state.mutate((s) => { s.pendingLeaves['ou_zhao'].subRound = 2; });
  const capped = await substitute.requestSubstitute('ou_zhao', '王五');
  check('超两轮 → 提示转补偿', capped.reply.includes('最多两轮'), capped.reply);

  console.log('== 3. confirmSubstitute：换人写表 + 补偿 + 回执 ==');
  const r3 = await substitute.confirmSubstitute('ou_wang');
  await new Promise((r) => setTimeout(r, 50));
  check('代班人回执=已确认代班', r3.reply.includes('已确认代班'), r3.reply.slice(0, 60));
  check('updateAssignee 写姓名+人员字段', updatedFields.length === 1 && updatedFields[0].fields['姓名'] === '王五' && updatedFields[0].fields['人员'][0].id === 'ou_wang', JSON.stringify(updatedFields[0] || {}));
  const s3 = state.load();
  check('双方会话已清', !s3.pendingSubstitutes['ou_wang'] && !s3.pendingLeaves['ou_li']);
  check('补偿义务已登记（照记口径）', s3.obligations.some((o) => o.name === '李四' && o.dutyDate === '2026-11-20' && o.reason.includes('请假')), JSON.stringify(s3.obligations));
  await new Promise((r) => setTimeout(r, 30));
  check('请假人收到回执私信', privateMsgs.some((m) => m.includes('已确认代班')), JSON.stringify(privateMsgs));
  privateMsgs = [];

  console.log('== 4. rejectSubstitute：轮次流转 ==');
  seedLeave('ou_li');
  await substitute.requestSubstitute('ou_li', '王五');
  const r4 = substitute.rejectSubstitute('ou_wang');
  check('代班人退回回执', r4.reply.includes('退回'));
  const s4 = state.load();
  check('代班会话清、请假会话保留', !s4.pendingSubstitutes['ou_wang'] && s4.pendingLeaves['ou_li'] && !s4.pendingLeaves['ou_li'].substitute);
  check('subRound=1（还可指定 1 轮）', s4.pendingLeaves['ou_li'].subRound === 1);
  await new Promise((r) => setTimeout(r, 30));
  check('请假人收到婉拒通知', privateMsgs.some((m) => m.includes('婉拒') && m.includes('还可指定 1 轮')), JSON.stringify(privateMsgs));
  privateMsgs = [];

  console.log('== 5. 第二轮拒绝后 → 轮次用尽提示 ==');
  await substitute.requestSubstitute('ou_li', '赵六');
  substitute.rejectSubstitute('ou_zhao');
  const s5 = state.load();
  check('subRound=2', s5.pendingLeaves['ou_li'].subRound === 2);
  await new Promise((r) => setTimeout(r, 30));
  check('用尽提示', privateMsgs.some((m) => m.includes('已用完')), JSON.stringify(privateMsgs));
  privateMsgs = [];

  console.log('== 6. cancelLeave 联动清理 ==');
  state.mutate((s) => {
    s.pendingLeaves = s.pendingLeaves || {};
    s.pendingLeaves['ou_li'] = { recordId: 'recDuty1', dateStr: '2026-11-20', position: '总负责', name: '李四', askedAt: new Date().toISOString() };
    s.pendingSubstitutes = { ou_wang: { recordId: 'recDuty1', leaveOpenId: 'ou_li', askedAt: new Date().toISOString() } };
  });
  substitute.cancelByLeaveOpenId('ou_li');
  check('取消请假清代班会话', !state.load().pendingSubstitutes['ou_wang']);

  console.log('== 7. sweepSubstituteTimeouts：超时清+通知+TTL 刷新 ==');
  const t0 = Date.now() - 11 * 60 * 1000;
  state.mutate((s) => {
    s.pendingSubstitutes = { ou_wang: { recordId: 'recDuty1', dateStr: '2026-11-20', position: '总负责', leaveName: '李四', leaveOpenId: 'ou_li', askedAt: new Date(t0).toISOString() } };
    s.pendingLeaves = { ou_li: { recordId: 'recDuty1', dateStr: '2026-11-20', position: '总负责', name: '李四', askedAt: new Date(t0).toISOString(), substitute: { name: '王五', openId: 'ou_wang', askedAt: new Date(t0).toISOString() } } };
  });
  const swept = await substitute.sweepSubstituteTimeouts();
  await new Promise((r) => setTimeout(r, 30));
  check('清扫数=1', swept.swept === 1);
  const s7 = state.load();
  check('超时会话清+subRound 递增', !s7.pendingSubstitutes['ou_wang'] && s7.pendingLeaves['ou_li'].subRound === 1 && !s7.pendingLeaves['ou_li'].substitute);
  check('请假会话 askedAt 刷新（新动作窗）', Date.parse(s7.pendingLeaves['ou_li'].askedAt) > t0);
  check('请假人收到超时通知', privateMsgs.some((m) => m.includes('超时未获')), JSON.stringify(privateMsgs));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
  process.exit(0);
})().catch((e) => { if (realFetch) global.fetch = realFetch; console.error('测试执行失败:', e); process.exit(1); });
