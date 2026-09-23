/**
 * 桩测试：排班生成的补偿义务 placed 即时标记——写表中途中断不产生双倍补偿（v34 复查批）
 * 复现原始缺陷：全部写表完成后才统一标记 placed，中途抛错（限频/网络）后管理员重试生成，
 * 未标记义务会被二次安置 → 同一队员拿到两笔插入。修复后逐日写表成功即落账。
 * 全离线：stub dutyTableService（可控失败的逐日写表+写入留痕）与 contacts/bot；状态写临时目录，跑完即删。
 * 运行：npm run test:generate-place（接入 push.js 部署闸门）
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- 环境隔离（必须在 require 任何 src 模块前设置） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-genplace-test-'));
process.env.PLAZA_BITABLE_TABLE_ID = ''; // 测试禁用动态广场写表
process.env.QUIET_HOURS_DISABLED = '1';
process.env.DUTY_STATE_FILE = path.join(TMP, 'state.json');
process.env.DUTY_MEMBERS_FILE = path.join(TMP, 'members.json');
process.env.DUTY_WHITELIST_FILE = path.join(TMP, 'whitelist.json');
fs.writeFileSync(process.env.DUTY_MEMBERS_FILE, JSON.stringify({
  members: [
    { name: '队员A', openId: 'ou_a', admin: true },
    { name: '队员B', openId: 'ou_b' },
    { name: '队员C', openId: 'ou_c' },
    { name: '队员D', openId: 'ou_d' },
  ],
}, null, 2));
fs.writeFileSync(process.env.DUTY_WHITELIST_FILE, JSON.stringify({ names: [] }));

// ---- dutyTableService 桩：可控失败的逐日写表 + 写入留痕 ----
const writtenDays = []; // {date, items}
let failFromCall = Infinity; // 第 N 次 createDayRecords 起抛错（1-based）
let calls = 0;
require.cache[require.resolve('../src/services/dutyTableService')] = {
  id: 'dutytable-stub', filename: 'dutytable-stub', loaded: true,
  exports: {
    async getAllDayRecords() {
      return writtenDays.map((d, i) => ({
        record_id: `rec_day${i}`,
        fields: { '姓名': d.items.map((it) => it.member.name), '日期': d.date },
      }));
    },
    async getLastScheduledDateStr() {
      return writtenDays.length ? writtenDays[writtenDays.length - 1].date : null;
    },
    async createDayRecords(dateStr, items) {
      calls += 1;
      if (calls >= failFromCall) throw new Error('模拟写表中断（限频/网络）');
      writtenDays.push({ date: dateStr, items });
      return items.map((it, i) => `rec_${dateStr}_${i}`);
    },
  },
};

// ---- contacts / bot 最小桩（generate 前同步通讯录；generate 本身不发消息） ----
require.cache[require.resolve('../src/feishu/contacts')] = {
  id: 'contacts-stub', filename: 'contacts-stub', loaded: true,
  exports: { async listAllUsers() {
    return [
      { name: '队员A', openId: 'ou_a', departments: '测试组' },
      { name: '队员B', openId: 'ou_b', departments: '测试组' },
      { name: '队员C', openId: 'ou_c', departments: '测试组' },
      { name: '队员D', openId: 'ou_d', departments: '测试组' },
    ];
  } },
};
require.cache[require.resolve('../src/feishu/bot')] = {
  id: 'bot-stub', filename: 'bot-stub', loaded: true,
  exports: {
    async sendTextToUser() { return {}; },
    async sendTextToChat() { return {}; },
    async sendCardToChat() { return {}; },
  },
};

const state = require('../src/services/stateStore');
const scheduleService = require('../src/services/scheduleService');
const { addDays, todayStr } = require('../src/utils/dates');

(async () => {
  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log(`  ✅ ${label}`); };

  // 种一条未落账补偿义务：队员B，目标周 = 生成范围首周（明天起排，必在范围内）
  const weekStart = addDays(todayStr(), 1);
  state.mutate((s) => {
    s.obligations = [{
      id: 'ob_test_1', name: '队员B', weekStart, createdAt: new Date().toISOString(),
      reason: '缺勤补偿', placed: false,
    }];
  });

  // 第一次生成：第 2 次写表抛错（第 1 天已入库）
  failFromCall = 2;
  let threw = false;
  try { await scheduleService.generate({ dryRun: false }); } catch { threw = true; }
  ok(threw, '中断场景：第二次写表抛错');
  const obligation = state.load().obligations[0];
  const day1Items = writtenDays[0] ? writtenDays[0].items : [];
  const bInDay1 = day1Items.some((it) => it.insertionName === '队员B');
  ok(obligation.placed === bInDay1, '中断后 placed 与已写日一致（已写日即时落账，未写日不误标）');

  // 第二次生成：桩恢复后重试
  failFromCall = Infinity;
  await scheduleService.generate({ dryRun: false });
  const insertionWrites = writtenDays.filter((d) => d.items.some((it) => it.insertionName === '队员B')).length;
  ok(insertionWrites === 1, '重试生成：义务只安置一次，无双倍补偿');
  ok(state.load().obligations[0].placed === true, '重试后义务已落账');

  console.log(`\n结果：${pass} 通过 / 0 失败`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => {
  console.error('❌ 测试失败:', err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
