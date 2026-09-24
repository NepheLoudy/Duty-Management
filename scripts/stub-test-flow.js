/**
 * M2 私信闭环干跑测试（stub：内存表格 + 捕获私信，不触网）
 * 覆盖：次日提醒/当日询问 → 是/否/照片写回 → 收口（未做完/总状态/补偿义务）
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

process.env.PLAZA_BITABLE_TABLE_ID = ''; // 测试禁用动态广场写表（防污染生产表）
process.env.QUIET_HOURS_DISABLED = '1';
// 周插入容量调大（主流程兼容旧行为；K=2 的容量行为在 7.5 用纯函数直接测）
process.env.DUTY_WEEKLY_INSERTION_ALLOWANCE = '10';
process.env.DUTY_MEMBERS_FILE = MEMBERS_FILE;
process.env.DUTY_WHITELIST_FILE = WHITELIST_FILE;
process.env.DUTY_STATE_FILE = path.join(TMP, 'state.json');
// 管辖策略不进本测（留空 = 不限制，群看板用例不受真实 .env 管辖列表影响）
process.env.DUTY_GROUP_CHAT_IDS = '';
// 看板通道不进本测（留空 = 回退应用身份，群看板用例不受真实 .env webhook 影响）
process.env.DUTY_BOARD_WEBHOOK_URL = '';

// ---- stub 注入（先于服务模块加载） ----
// 通讯录 stub：名册同步回显当前名册文件（openId 原样保留，未绑定仍为空，测试语义不变）
require.cache[require.resolve('../src/feishu/contacts')] = {
  id: 'contacts-stub', filename: 'contacts-stub', loaded: true,
  exports: { async listAllUsers() {
    const raw = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf-8'));
    return (raw.members || []).map((m) => ({ name: m.name, openId: m.openId || '', departments: '测试组' }));
  } },
};
const memory = { records: [], seq: 1, dmCalls: [], cards: [], fileTokens: [], downloadCalls: [] };

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
    async batchDeleteRecords(recordIds) {
      const deleted = [];
      for (const id of recordIds) {
        const idx = memory.records.findIndex((x) => x.record_id === id);
        if (idx >= 0) { memory.records.splice(idx, 1); deleted.push(id); }
      }
      return deleted;
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
    // 记录入参：downloadImage(messageId, imageKey)——2026-09-16 换消息资源接口，messageId 必传
    async downloadImage(...args) { memory.downloadCalls.push(args); return Buffer.from('fake-image'); },
    async uploadMediaToBitable(buf, fileName) {
      const token = `file_${memory.seq++}`;
      memory.fileTokens.push({ token, fileName });
      return token;
    },
    async requestAPI() { return { code: 0, data: {} }; },
  },
};

// DDL 冲突客户端桩：conflictIds 可控（18:30 询问冲突提示用，2026-09-13 口径）
let conflictIds = [];
require.cache[require.resolve('../src/services/ddlConflictClient')] = {
  id: 'ddl-conflict-stub', filename: 'ddl-conflict-stub', loaded: true,
  exports: { async hasPendingDdlConfirm(openId) { return conflictIds.includes(openId); } },
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
  check('当日询问：无 DDL 冲突 → 不加冲突提示', !memory.dmCalls.some((c) => c.text.includes('DDL 逾期确认待回复')));

  // 有未过期 DDL 确认的成员（队员A）：重新询问应带冲突提示，且主词为「打卡」
  conflictIds = ['ou_test_a'];
  await inquiry.askToday();
  const askA = memory.dmCalls.filter((c) => c.openId === 'ou_test_a' && c.text.includes('值日完成了吗')).pop();
  check('当日询问：有 DDL 冲突 → 询问带额外提示（仅冲突成员）',
    askA && askA.text.includes('DDL 逾期确认待回复') && askA.text.includes('值日请回复「打卡」')
    && memory.dmCalls.filter((c) => c.text.includes('DDL 逾期确认待回复')).length === 1,
    askA && askA.text);
  conflictIds = [];

  // ---- 3. 是/否/打卡/照片写回 ----
  const checkin = await assistant.handleCommand({ command: '打卡', openId: 'ou_test_a', chatType: 'p2p' });
  check('队员A 回「打卡」→ 已做完（主词，效果等同「是」）', checkin.handled && checkin.reply.includes('已记录'), checkin.reply);
  const yesCompat = await assistant.handleCommand({ command: '是', openId: 'ou_test_a', chatType: 'p2p' });
  check('队员A 再回「是」→ 兼容保留（仍被值日分支接管）', yesCompat.handled === true, JSON.stringify(yesCompat));
  const imgB = await inquiry.handleImage({ openId: 'ou_test_b', imageKey: 'img_key_1', messageId: 'om_1' });
  check('队员B 传照片 → 回执累计 1 张', imgB.handled && imgB.reply.includes('该岗累计 1 张'), imgB.reply);
  // 多图（富文本一次多张，2026-09-17）：全量收录 + 累计计数
  const imgB2 = await inquiry.handleImage({ openId: 'ou_test_b', imageKeys: ['img_key_2', 'img_key_3'], messageId: 'om_2' });
  check('队员B 再传 2 张（多图载荷）→ 累计 3 张', imgB2.handled && imgB2.reply.includes('共 2 张') && imgB2.reply.includes('该岗累计 3 张'), imgB2.reply);
  check('多图逐张下载：downloadImage 共收到 3 次入参', memory.downloadCalls.length === 3
    && memory.downloadCalls[1][1] === 'img_key_2' && memory.downloadCalls[2][1] === 'img_key_3',
    JSON.stringify(memory.downloadCalls));
  check('照片下载走消息资源接口：downloadImage 收到 (messageId, imageKey)',
    memory.downloadCalls[0] && memory.downloadCalls[0][0] === 'om_1' && memory.downloadCalls[0][1] === 'img_key_1',
    JSON.stringify(memory.downloadCalls));
  const noC = await inquiry.handleNo('ou_test_c');
  check('队员C 回「否」→ 提示补救，不改状态', noC.handled && noC.reply.includes('收口前'));

  const recs = await dutyTable.getRecordsByDate(today);
  const recA = recs.find((r) => r.name === '队员A');
  const recB = recs.find((r) => r.name === '队员B');
  check('队员A 状态=已做完（打卡）', recA.status === '已做完', recA.status);
  check('队员B 照片已挂「凭证-工位」（含多图共 3 张）', recB.receiptCounts['工位区'] === 3, JSON.stringify(recB.receiptCounts));
  check('队员B 状态仍为空（照片≠已完成）', !recB.status);

  // 陌生人/未绑定者
  const stranger = await inquiry.handleYes('ou_unknown');
  check('非值日队员回「是」→ 礼貌忽略', stranger.handled === false && stranger.reply.includes('值日助手'));

  // ---- 3.5 21:00 临门提醒（2026-09-16） ----
  const lastcallDry = await inquiry.sendLastCall({ dryRun: true });
  check('临门提醒 dryRun：未完结 2 人（队员B/队员C）', lastcallDry.sent.length === 2, JSON.stringify(lastcallDry.sent.map((x) => x.name)));
  check('临门提醒 dryRun：队员A 已完结不打扰', !lastcallDry.sent.some((x) => x.name === '队员A'));
  await inquiry.sendLastCall();
  check('临门提醒：私信 2 人且带收口倒计时指引', memory.dmCalls.filter((c) => c.text.includes('还剩约 1 小时')).length === 2);
  check('临门提醒：队员B 已传照片 → 提示只需打卡', memory.dmCalls.some((c) => c.openId === 'ou_test_b' && c.text.includes('照片已收到')));
  check('临门提醒：未传照片者引导照片+打卡', memory.dmCalls.some((c) => c.openId === 'ou_test_c' && c.text.includes('上传现场照片')));

  // ---- 4. 收口 ----
  const close = await inquiry.closeToday({ dryRun: true });
  check('收口 dryRun：队员B/C 判未做完', close.results.filter((r) => r.status === '未做完').length === 2);
  const closed = await inquiry.closeToday();
  check('收口：当日总状态为空（缺凭证/未全做完）', closed.dayStatus === null, String(closed.dayStatus));
  check('收口：photoOnly 名单含队员B', closed.notifications.photoOnly.some((p) => p.name === '队员B'));
  check('收口：missNotices 覆盖全部未做完（B 有照片/C 无照片）', closed.notifications.missNotices.length === 2 && closed.notifications.missNotices.some((m) => m.name === '队员B' && m.photos) && closed.notifications.missNotices.some((m) => m.name === '队员C' && !m.photos), JSON.stringify(closed.notifications.missNotices));
  await inquiry.sendCloseNotifications(closed.notifications);
  const closeDm = memory.dmCalls.filter((c) => c.text.includes('已按「未做完」收口'));
  check('收口：未做完者本人收到私信回执（含补偿与值日助手引导）', closeDm.length === 2 && closeDm.every((c) => c.text.includes('补偿值日') || c.text.includes('回复「打卡」')) && closeDm.some((c) => c.text.includes('值日助手')), JSON.stringify(closeDm.map((c) => c.text.slice(0, 40))));
  check('收口：会话已清空', Object.keys(state.load().sessions).length === 0);
  const obligations = state.load().obligations;
  check('收口：未做完成员补偿义务 2 条（队员B/队员C）', obligations.length === 2 && obligations.every((o) => ['队员B', '队员C'].includes(o.name)), JSON.stringify(obligations.map((o) => o.name)));
  // 收口幂等（2026-09-13）：同日第二次真实收口不得重复登记补偿/虚增强罚
  await inquiry.closeToday();
  check('收口幂等：同日第二次收口补偿义务不重复', state.load().obligations.length === 2, JSON.stringify(state.load().obligations.map((o) => o.name)));
  const secondClose = await inquiry.closeToday();
  check('收口幂等：二次收口 missNotices 为空（私信不重发）', secondClose.notifications.missNotices.length === 0, JSON.stringify(secondClose.notifications.missNotices));
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

  // ---- 6. 请假（队员D 未来班次：两步确认 → 已请假 + 新义务 + 当日抽调补位） ----
  // 2026-09-24 请假二次确认：requestLeave 只登记意向点名日期，confirmLeave 才生效
  const leaveAsk = await inquiry.requestLeave(roster.findByName('队员D'));
  check('队员D 请假第一步：确认会话点名日期', leaveAsk.handled && leaveAsk.reply.includes('请假确认') && leaveAsk.reply.includes('确认请假'), leaveAsk.reply);
  check('请假第一步未生效（表格无已请假状态）',
    (await dutyTable.getAllDayRecords()).every((r) => !(r.name === '队员D' && r.status === '已请假')));
  check('请假第一步不生成义务', state.load().obligations.filter((o) => !o.placed).length === 0,
    JSON.stringify(state.load().obligations.filter((o) => !o.placed)));
  // 误触保护：取消 → 确认失效 → 重新发起 → 确认生效
  const leaveCancel = await inquiry.cancelLeave('ou_test_d');
  check('取消请假：回执已取消', leaveCancel.handled && leaveCancel.reply.includes('已取消'), leaveCancel.reply);
  const leaveStale = await inquiry.confirmLeave('ou_test_d');
  check('取消后确认：提示无待确认', leaveStale.handled && leaveStale.reply.includes('没有待确认的请假'), leaveStale.reply);
  await inquiry.requestLeave(roster.findByName('队员D'));
  const leave = await inquiry.confirmLeave('ou_test_d');
  check('队员D 请假第二步：已登记请假', leave.handled && leave.reply.includes('已登记请假'), leave.reply);
  const pendingOb = state.load().obligations.filter((o) => !o.placed);
  check('请假生成 1 条下周插入义务', pendingOb.length === 1 && pendingOb[0].name === '队员D', JSON.stringify(pendingOb));
  // 补位已废除（2026-09-25 口径）：请假当日该岗空缺，不再抽人顶班——
  // 该日记录数保持 3（1 条已请假 + 2 条正常），无第 4 条补位记录、无补位私信
  let dCanPlace = null; // 对账前快照：D 的义务能否就地安置（供步骤 7 断言用）
  let dLeaveWeekStart = null; // D 义务目标周起点（供步骤 7 顺延断言比对）
  {
    const algo = require('../src/services/scheduleAlgo');
    const all = await dutyTable.getAllDayRecords();
    const dLeave = all.find((r) => r.name === '队员D' && r.status === '已请假');
    const sameDay = all.filter((r) => r.dateStr === dLeave.dateStr);
    check('请假当日空缺：该日无第 4 条补位记录', sameDay.length === 3,
      JSON.stringify(sameDay.map((r) => [r.name, r.position, r.status])));
    check('请假回执说明当日空缺', leave.reply.includes('空缺'), leave.reply);
    check('请假不发送补位私信', !memory.dmCalls.some((c) => c.text.includes('补位通知')),
      JSON.stringify(memory.dmCalls.map((c) => c.text.slice(0, 20))));

    // 目标周能否安置 D 的义务——快照必须取**对账前**：安置本身会占掉空位日，
    // 对账后再算会自相矛盾（该断言曾对真实日期敏感误报，2026-09-13 修正）
    const weekStart = addDays(mondayOf(dLeave.dateStr), 7);
    dLeaveWeekStart = weekStart;
    const weekEnd = addDays(weekStart, 6);
    const assignments = new Map();
    for (const r of all) {
      if (!assignments.has(r.dateStr)) assignments.set(r.dateStr, []);
      assignments.get(r.dateStr).push({ name: r.name, position: r.position, status: r.status });
    }
    dCanPlace = Boolean(algo.planInsertion({
      weekStartStr: weekStart, rangeStart: weekStart, rangeEnd: weekEnd,
      memberName: '队员D', assignments,
    }));
  }

  // ---- 7. 对账（含：admin 手工标记的已请假也要补登记进下周队列） ----
  {
    const yesterday = addDays(today, -1);
    const ids = await dutyTable.createDayRecords(yesterday, [
      { member: roster.findByName('队员C'), position: '总负责' },
    ]);
    // 模拟管理员直接在表格里把该记录标成「已请假」（非私信请假路径）
    await dutyTable.setStatus(ids[0], '已请假');
  }
  const recon = await compensation.reconcile({});
  const yObl = state.load().obligations.find((o) => o.name === '队员C' && o.dutyDate === addDays(today, -1));
  check('对账：admin 手工标记的已请假补登记进下周队列', Boolean(yObl), JSON.stringify(state.load().obligations.map((o) => [o.name, o.reason, o.dutyDate])));
  check('对账：补登记有回执提示', recon.report.includes('补登记 1 条'), recon.report);
  const recon2 = await compensation.reconcile({});
  check('对账：同一条手工标记不重复登记（去重）', !recon2.report.includes('补登记'), recon2.report);
  // 断言定向到 D 本人（2026-09-19）：此前检查全局 stillQueued.length，会被同周其他
  // 队员的义务（如 C 满周顺延）误伤——日期敏感误报即此因
  const dObl = state.load().obligations.find((o) => o.name === '队员D' && o.reason === '已请假');
  check('对账：队员D 义务按目标周空位情况正确处置',
    dCanPlace ? Boolean(dObl && dObl.placed) : Boolean(!dObl || !dObl.placed),
    `canPlace(对账前)=${dCanPlace} placed=${dObl && dObl.placed} placedDate=${dObl && dObl.placedDate}`);
  // 满周顺延（2026-09-19 新行为）：同周其它义务若无处安置，必须 placed 或顺延到目标周之后，
  // 不允许静默留队等过期
  const cLeaveObl = state.load().obligations.find((o) => o.name === '队员C' && o.reason === '已请假');
  check('对账：满周无处安置的义务顺延不丢（placed 或 weekStart 后移）',
    Boolean(cLeaveObl) && (cLeaveObl.placed || cLeaveObl.weekStart > dLeaveWeekStart),
    JSON.stringify(cLeaveObl));

  // ---- 7.5 加罚口径 + 补位密度（2026-09-24，置于对账后避免新义务被安置干扰 brief 断言） ----
  {
    // 加罚只计「未做完」：连续两次未做完触发加罚（义务翻倍），请假不计数
    const obBefore = state.load().obligations.length;
    const a1 = compensation.handleAbsence('队员A', addDays(today, -2), '未做完');
    check('加罚口径：未做完第1次不加罚', a1.created.length === 1 && !a1.penalty && a1.streak === 1, JSON.stringify(a1));
    const a2 = compensation.handleAbsence('队员A', addDays(today, -1), '未做完');
    check('加罚口径：未做完第2次触发加罚（义务2条+带标记）',
      a2.created.length === 2 && a2.penalty && a2.created.some((c) => c.reason.includes('加罚')),
      JSON.stringify(a2.created.map((c) => c.reason)));
    check('加罚口径：连续未做完义务共 3 条（2+加罚1）', state.load().obligations.length === obBefore + 3);
    // 请假不计数：连续请假两次不加罚、streak 原值不动（B 此前收口场景可能已有计数）
    const bStreakBefore = (state.load().absenceStreaks['队员B'] || { count: 0 }).count;
    const b1 = compensation.handleAbsence('队员B', addDays(today, -2), '已请假');
    const b2 = compensation.handleAbsence('队员B', addDays(today, -1), '已请假');
    check('加罚口径：连续请假两次各只1条义务、不加罚',
      b1.created.length === 1 && b2.created.length === 1 && !b2.penalty,
      JSON.stringify({ b1: b1.created.length, b2: b2.created.length, penalty: b2.penalty }));
    check('加罚口径：请假不改变 streak（不计入）',
      (state.load().absenceStreaks['队员B'] || { count: 0 }).count === bStreakBefore);
    const m2 = compensation.handleAbsence('队员X', addDays(today, -1), '未做完');
    check('加罚口径：请假后首次未做完只算第1次', m2.created.length === 1 && !m2.penalty && m2.streak === 1, JSON.stringify(m2));

    // 请假空缺位优先（2026-09-25 检修）：planInsertion 对带 status 的快照优先填已请假空缺岗
    {
      const algo = require('../src/services/scheduleAlgo');
      const monday = addDays(today, 7); // 任取一个目标周
      const am = new Map();
      am.set(monday, [{ name: '队员A', position: '总负责' }]);
      am.set(addDays(monday, 1), [{ name: '队员B', position: '总负责', status: '已请假' }]); // 请假空缺位
      const plan = algo.planInsertion({
        weekStartStr: monday, rangeStart: monday, rangeEnd: addDays(monday, 6),
        memberName: '队员C', assignments: am,
      });
      check('安置优先级：请假空缺位优先且同岗回填', plan && plan.fillLeave === true && plan.dateStr === addDays(monday, 1) && plan.position === '总负责', JSON.stringify(plan));

      // 周级插入容量（K=2）：第 3 条非请假位插入必须留队
      const gen = algo.generateSchedule({
        members: [{ name: '队员A' }, { name: '队员B' }, { name: '队员C' }, { name: '队员D' }],
        startDateStr: addDays(today, 7), days: 7, history: [],
        insertions: [
          { id: 'i1', name: '队员A', weekStartStr: monday },
          { id: 'i2', name: '队员B', weekStartStr: monday },
          { id: 'i3', name: '队员C', weekStartStr: monday },
        ],
        weeklyAllowance: 2, seedStr: 'cap-test',
      });
      check('周容量：K=2 时第 3 条义务留队不插入', gen.unplacedInsertions.length === 1 && gen.unplacedInsertions[0].name === '队员C',
        JSON.stringify(gen.unplacedInsertions));
      const insertedCount = gen.days.reduce((n, d) => n + d.items.filter((it) => it.isInsertion).length, 0);
      check('周容量：实际插入仅 2 条', insertedCount === 2, String(insertedCount));
    }

    // rebalance（2026-09-25 检修）：未来未完成班次重排，历史与已定状态保留
    {
      // 构造一个未来 4 人日（模拟存量超员）
      await dutyTable.createDayRecords(addDays(today, 10), [{ member: roster.findByName('队员C'), position: '总负责' }]);
      const preview = await scheduleService.rebalance({});
      check('重排预览：识别待删未完成班次', preview.dryRun && preview.deleteCount >= 4,
        JSON.stringify({ deleteCount: preview.deleteCount }));
      check('重排预览：未来保留的都是已定状态（已请假/未做完）',
        preview.keptFuture.every((line) => line.includes('已请假') || line.includes('未做完')),
        JSON.stringify(preview.keptFuture));
      const done = await scheduleService.rebalance({ confirm: true, weeklyAllowance: 2 });
      check('重排执行：备份+删除+重生成', !done.dryRun && done.deleteCount >= 4 && done.generated.recordCount > 80,
        JSON.stringify({ deleteCount: done.deleteCount, generated: done.generated, backup: done.backupPath }));
      const allAfter = await dutyTable.getAllDayRecords();
      const futureDays = new Map();
      for (const r of allAfter) {
        if (r.dateStr > today) {
          if (!futureDays.has(r.dateStr)) futureDays.set(r.dateStr, []);
          futureDays.get(r.dateStr).push(r);
        }
      }
      const overFive = [...futureDays.values()].filter((rs) => rs.length > 4);
      check('重排后：未来无 5 人日', overFive.length === 0,
        JSON.stringify(overFive.map((rs) => `${rs[0] && rs[0].dateStr}:${rs.length}`)));
      const overThree = [...futureDays.entries()].filter(([, rs]) => rs.length > 3);
      const overByWeek = new Map();
      for (const [d] of overThree) {
        const wk = mondayOf(d);
        overByWeek.set(wk, (overByWeek.get(wk) || 0) + 1);
      }
      check('重排后：每周 4 人日不超过容量 K=2',
        [...overByWeek.values()].every((n) => n <= 2),
        JSON.stringify({ overThree: overThree.map(([d, rs]) => `${d}:${rs.length}`), byWeek: [...overByWeek.entries()] }));
    }
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
  check('brief：昨日 1 人（对账补的记录）、今日 3 人', brief.yesterday.members.length === 1 && brief.today.members.length === 3, JSON.stringify(brief.today));
  check('brief：昨日 dayStatus=null（未完成口径）', brief.yesterday.dayStatus === null);

  // ---- 10. D-7 值日预告（2026-09-24 新增） ----
  const weekAhead = await inquiry.sendWeekAheadRemind({ dryRun: true });
  check('D-7 预告：目标日=今天+7 且有班次可发',
    weekAhead.date === addDays(today, 7) && weekAhead.sent.length > 0,
    JSON.stringify({ date: weekAhead.date, sent: weekAhead.sent.length, skipped: weekAhead.skipped }));
  check('D-7 预告：文案点名日期与岗位（dryRun 预览）',
    weekAhead.sent.every((s) => s.preview.includes(weekAhead.date) && s.preview.includes(s.position)),
    JSON.stringify(weekAhead.sent.map((s) => s.name)));
  check('D-7 预告：请假引导指向两步确认', weekAhead.sent.every((s) => s.preview.includes('我要请假')));

  console.log(failed === 0 ? `\n全部通过 ✅（临时目录 ${TMP}）` : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
