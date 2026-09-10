/**
 * M2 私信闭环干跑测试（stub：内存表格 + 捕获私信，不触网）
 * 覆盖：次日提醒/当日询问 → 是/否/照片写回 → 22:00 收口（未做完/总状态/补偿义务）
 *      → 生成排班（插入优先安置）→ 请假 → 对账 → 值日助手指令路由/绑定/群看板限流。
 * 运行：npm run test:flow
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

// ---- 环境隔离：fixture 名册/白名单 + 临时状态文件（必须在 require 任何 src 模块前设置） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-bot-test-'));
const MEMBERS_FILE = path.join(TMP, 'members.json');
const WHITELIST_FILE = path.join(TMP, 'whitelist.json');
fs.writeFileSync(MEMBERS_FILE, JSON.stringify({
  members: [
    { name: '队员A', openId: 'ou_test_a', admin: true },
    { name: '队员B', openId: 'ou_test_b' },
    { name: '队员C', openId: 'ou_test_c' },
    { name: '队员D', openId: 'ou_test_d' },
    { name: '队员E', openId: '' },
  ],
}, null, 2));
fs.writeFileSync(WHITELIST_FILE, JSON.stringify({ names: ['队员E'] }));

process.env.QUIET_HOURS_DISABLED = '1';
process.env.DUTY_MEMBERS_FILE = MEMBERS_FILE;
process.env.DUTY_WHITELIST_FILE = WHITELIST_FILE;
process.env.DUTY_STATE_FILE = path.join(TMP, 'state.json');

// ---- stub 注入（先于服务模块加载） ----
const memory = { records: [], seq: 1, dmCalls: [], cards: [], fileTokens: [] };

require.cache[require.resolve('../src/feishu/bitable')] = {
  id: 'bitable-stub', filename: 'bitable-stub', loaded: true, exports: {
    async listAllRecords() { return memory.records.map((r) => ({ record_id: r.record_id, fields: r.fields })); },
    async batchCreateRecords(fieldsList) {
      const ids = [];
      for (const { fields } of fieldsList) {
        const id = `rec${memory.seq++}`;
        memory.records.push({ record_id: id, fields });
        ids.push(id);
      }
      return ids;
    },
    async updateRecord(recordId, fields) {
      const r = memory.records.find((x) => x.record_id === recordId);
      if (!r) throw new Error(`记录不存在: ${recordId}`);
      r.fields = { ...r.fields, ...fields };
      return {};
    },
    async listFields() { return []; },
  },
};

require.cache[require.resolve('../src/feishu/bot')] = {
  id: 'bot-stub', filename: 'bot-stub', loaded: true, exports: {
    async sendTextToUser(openId, text) { memory.dmCalls.push({ openId, text }); return {}; },
    async sendTextToChat() { return {}; },
    async sendCardToChat(chatId, card) { memory.cards.push({ chatId, card }); return {}; },
  },
};

require.cache[require.resolve('../src/feishu/client')] = {
  id: 'client-stub', filename: 'client-stub', loaded: true, exports: {
    async downloadImage() { return Buffer.from('fake-image'); },
    async uploadMediaToBitable(buf, fileName) {
      const token = `file_${memory.seq++}`;
      memory.fileTokens.push({ token, fileName });
      return token;
    },
    async requestAPI() { return { code: 0, data: {} }; },
  },
};

// ---- 被测模块 ----
const config = require('../src/config');
const { todayStr, addDays, mondayOf } = require('../src/utils/dates');
const roster = require('../src/services/rosterService');
const dutyTable = require('../src/services/dutyTableService');
const scheduleService = require('../src/services/scheduleService');
const inquiry = require('../src/services/inquiryService');
const compensation = require('../src/services/compensationService');
const assistant = require('../src/services/assistantService');
const state = require('../src/services/stateStore');

let failed = 0;
function check(desc, cond, detail = '') {
  if (cond) console.log(`✓ ${desc}`);
  else { failed += 1; console.error(`❌ ${desc}${detail ? ` —— ${detail}` : ''}`); }
}

(async () => {
  const today = todayStr();
  check('环境隔离：状态文件落在临时目录', config.stateFile.startsWith(TMP));

  // ---- 0. 预置今日排班（A=总负责，B=工位区，C=装配区） ----
  await dutyTable.createDayRecords(today, [
    { member: roster.findByName('队员A'), position: '总负责' },
    { member: roster.findByName('队员B'), position: '工位区' },
    { member: roster.findByName('队员C'), position: '装配区' },
  ]);
  const queue = roster.getQueue();
  check('白名单生效：值日队列 4 人（队员E 被排除）', queue.length === 4, `实际 ${queue.length}`);

  // ---- 1. D-1 提醒（明日暂无排班 → 0 条；仅验证不炸） ----
  const remind = await inquiry.sendPrevDayRemind();
  check('D-1 提醒：明日无排班时不发送', remind.sent.length === 0);

  // ---- 2. 当日询问 ----
  const dryAsk = await inquiry.askToday({ dryRun: true });
  check('当日询问 dryRun：3 人待询问', dryAsk.asked.length === 3, JSON.stringify(dryAsk.asked));
  const ask = await inquiry.askToday();
  check('当日询问：私信 3 人', memory.dmCalls.filter((c) => c.text.includes('值日完成了吗')).length === 3);
  check('当日询问：会话建立 3 个', Object.keys(state.load().sessions).length === 3);

  // ---- 3. 是/否/照片写回 ----
  const yes = await inquiry.handleYes('ou_test_a');
  check('队员A 回「是」→ 已做完', yes.handled && yes.reply.includes('已记录'));
  const imgB = await inquiry.handleImage({ openId: 'ou_test_b', imageKey: 'img_key_1', messageId: 'om_1' });
  check('队员B 传照片 → 回执第 1 张', imgB.handled && imgB.reply.includes('第 1 张'), imgB.reply);
  const noC = await inquiry.handleNo('ou_test_c');
  check('队员C 回「否」→ 提示补救，不改状态', noC.handled && noC.reply.includes('22:00'));

  const recs = await dutyTable.getRecordsByDate(today);
  const recA = recs.find((r) => r.name === '队员A');
  const recB = recs.find((r) => r.name === '队员B');
  check('队员A 状态=已做完', recA.status === '已做完', recA.status);
  check('队员B 照片已挂「凭证-工位」', recB.receiptCounts['工位区'] === 1, JSON.stringify(recB.receiptCounts));
  check('队员B 状态仍为空（照片≠已完成）', !recB.status);

  // 陌生人/未绑定者
  const stranger = await inquiry.handleYes('ou_unknown');
  check('非值日队员回「是」→ 礼貌忽略', stranger.handled === false && stranger.reply.includes('值日助手'));

  // ---- 4. 22:00 收口 ----
  const close = await inquiry.closeToday({ dryRun: true });
  check('收口 dryRun：队员B/C 判未做完', close.results.filter((r) => r.status === '未做完').length === 2);
  const closed = await inquiry.closeToday();
  check('收口：当日总状态为空（缺凭证/未全做完）', closed.dayStatus === null, String(closed.dayStatus));
  check('收口：photoOnly 名单含队员B', closed.notifications.photoOnly.some((p) => p.name === '队员B'));
  check('收口：会话已清空', Object.keys(state.load().sessions).length === 0);
  const obligations = state.load().obligations;
  check('收口：未做完成员补偿义务 2 条（队员B/队员C）', obligations.length === 2 && obligations.every((o) => ['队员B', '队员C'].includes(o.name)), JSON.stringify(obligations.map((o) => o.name)));
  const afterClose = await dutyTable.getRecordsByDate(today);
  check('收口：队员C 状态=未做完', afterClose.find((r) => r.name === '队员C').status === '未做完');

  // ---- 5. 生成排班（补偿插入优先安置 → 出现 4 人日） ----
  const gen = await scheduleService.generate({ dryRun: true });
  check('生成 dryRun：从明天起生成一个月', gen.startDate === addDays(today, 1) && gen.dayCount >= 28, `${gen.startDate} ${gen.dayCount}天`);
  check('生成 dryRun： dryRun 不落表', (await dutyTable.getAllDayRecords()).length === 3);

  const genReal = await scheduleService.generate({});
  check('生成：正式落表 >80 条记录', (await dutyTable.getAllDayRecords()).length > 80);
  check('生成：dryRun 与正式的配额核对行数一致（队列 4 人）', genReal.quotaReport.length === 4);
  check('生成：补偿插入全部安置', state.load().obligations.every((o) => o.placed), JSON.stringify(state.load().obligations));

  // 插入日应为 4 人（某岗两人）
  const fourDay = genReal.days.find((d) => d.items.length === 4);
  check('生成：出现 4 人插入日', Boolean(fourDay), JSON.stringify(genReal.days.slice(0, 3)));

  // ---- 6. 请假（队员D 未来班次 → 已请假 + 新义务） ----
  const leave = await inquiry.requestLeave(roster.findByName('队员D'));
  check('队员D 请假成功', leave.handled && leave.reply.includes('已登记请假'), leave.reply);
  const pendingOb = state.load().obligations.filter((o) => !o.placed);
  check('请假生成 1 条下周插入义务', pendingOb.length === 1 && pendingOb[0].name === '队员D', JSON.stringify(pendingOb));

  // ---- 7. 对账 ----
  const recon = await compensation.reconcile({});
  check('对账：昨日无记录不炸', recon.report.includes('无记录'));
  // 队员D 义务就地安置的前提：目标周内存在他没有班次的空位日
  //（4 人小队间隔约束放宽后可能整周天天在班，此时留队为正确行为）
  {
    const all = await dutyTable.getAllDayRecords();
    const dLeave = all.find((r) => r.name === '队员D' && r.status === '已请假');
    const weekStart = addDays(mondayOf(dLeave.dateStr), 7);
    const weekEnd = addDays(weekStart, 6);
    const dDays = new Set(all.filter((r) => r.name === '队员D' && r.dateStr >= weekStart && r.dateStr <= weekEnd).map((r) => r.dateStr));
    let hasFreeDay = false;
    for (let d = weekStart; d <= weekEnd; d = addDays(d, 1)) {
      if (!dDays.has(d)) hasFreeDay = true;
    }
    check('对账：队员D 义务按目标周空位情况正确处置',
      hasFreeDay ? recon.stillQueued.length === 0 : recon.stillQueued.length === 1,
      `hasFreeDay=${hasFreeDay} queued=${recon.stillQueued.length}`);
  }

  // ---- 8. 值日助手指令 ----
  const help = await assistant.handleCommand({ command: '值日助手', openId: 'ou_test_a', chatType: 'p2p' });
  check('私信「值日助手」→ 用法说明', help.reply.includes('值日助手用法'));

  const deny = await assistant.handleCommand({ command: '生成排班表', openId: 'ou_test_b', chatType: 'p2p' });
  check('非管理员「生成排班表」→ 拒绝', deny.reply.includes('仅限管理员'));

  const unknown = await assistant.handleCommand({ command: '是', openId: 'ou_unknown', chatType: 'p2p' });
  check('未绑定者回「是」→ 引导绑定', unknown.reply.includes('绑定'));

  // 绑定：队员E 拿到账号后私信绑定（写入 fixture 名册）
  const bind = await assistant.handleCommand({ command: '绑定 队员E', openId: 'ou_test_e', chatType: 'p2p' });
  check('「绑定 队员E」成功', bind.reply.includes('已绑定'), bind.reply);
  check('绑定后可按 open_id 识别', (roster.findByOpenId('ou_test_e') || {}).name === '队员E');

  // 查询下一次值日
  const next = await assistant.handleCommand({ command: '查询我的下一次值日', openId: 'ou_test_b', chatType: 'p2p' });
  check('查询下一次值日 → 返回日期岗位', next.reply.includes('下一次值日'), next.reply);

  // 群看板限流
  await assistant.handleCommand({ command: '值日助手', openId: 'ou_test_a', chatType: 'group', chatId: 'oc_test' });
  const second = await assistant.handleCommand({ command: '值日助手', openId: 'ou_test_a', chatType: 'group', chatId: 'oc_test' });
  check('群看板：发送 1 次卡，第二次命中限流静默', memory.cards.length === 1 && second.rateLimited === true);

  // 收口回执通知（手动触发 = 不受静默限制，直接发送）
  await inquiry.sendCloseNotifications({ photoOnly: [{ name: '队员B', openId: 'ou_test_b' }], adminText: '测试摘要' });
  check('收口回执：photoOnly 提醒 + 管理员摘要均发出', memory.dmCalls.some((c) => c.openId === 'ou_test_b' && c.text.includes('未做完')) && memory.dmCalls.some((c) => c.text === '测试摘要'));

  // ---- 9. brief 数据接口 ----
  const brief = await scheduleService.getBrief();
  check('brief：昨日为空、今日 3 人', brief.yesterday.members.length === 0 && brief.today.members.length === 3, JSON.stringify(brief.today));
  check('brief：昨日 dayStatus=null（未完成口径）', brief.yesterday.dayStatus === null);

  console.log(failed === 0 ? `\n全部通过 ✅（临时目录 ${TMP}）` : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
