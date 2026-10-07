/**
 * 管辖策略 stub 测试（stub：临时状态文件 + mock 表格/飞书层，不触网）
 * 覆盖：GET /api/duty/policy 结构与下发、管辖判定（含留空不限语义）、
 *      群看板的管辖校验（非管辖群拒绝、管辖群正常出卡）。
 * 运行：npm run test:policy
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

// ---- 环境隔离（必须在 require 任何 src 模块前设置） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-bot-policy-test-'));
// 静默窗口按当前上海小时动态开启（覆盖当前时刻）：供 gateTask 同名合并断言用；
// 其余用例不受影响（cron 定时任务在本测不启动，gateTask 只在显式调用时写积压）
const shH = Math.floor((Date.now() / 1000 + 8 * 3600) / 3600) % 24;
process.env.QUIET_HOURS_DISABLED = '0';
if (shH >= 23) {
  process.env.QUIET_HOURS_START = '23';
  process.env.QUIET_HOURS_END = '0'; // 跨午夜写法：23 点后全程静默
} else {
  process.env.QUIET_HOURS_START = String(shH);
  process.env.QUIET_HOURS_END = String(shH + 1);
}
process.env.QUIET_BACKLOG_FILE = path.join(TMP, 'quiet-backlog.json');
process.env.DUTY_STATE_FILE = path.join(TMP, 'state.json');
process.env.DUTY_MEMBERS_FILE = path.join(TMP, 'members.json');
process.env.DUTY_WHITELIST_FILE = path.join(TMP, 'whitelist.json');
fs.writeFileSync(process.env.DUTY_MEMBERS_FILE, JSON.stringify({ members: [{ name: '队员A', openId: 'ou_test_a', admin: true }] }));
fs.writeFileSync(process.env.DUTY_WHITELIST_FILE, JSON.stringify({ names: [] }));
// 管辖范畴：两个值日专用群
process.env.DUTY_GROUP_CHAT_IDS = 'oc_managed_a,oc_managed_b';
process.env.DUTY_BOARD_WEBHOOK_URL = '';

// ---- stub 注入（先于服务模块加载）：表格返回空记录、捕获发出的卡片 ----
const cardsSent = [];
require.cache[require.resolve('../src/services/dutyTableService')] = {
  id: 'dutyTable-stub', filename: 'dutyTable-stub', loaded: true,
  exports: {
    async getRecordsByDate() { return []; },
    computeDayStatus() { return null; },
  },
};
require.cache[require.resolve('../src/feishu/bot')] = {
  id: 'bot-stub', filename: 'bot-stub', loaded: true,
  exports: {
    async sendCardToChat(chatId) { cardsSent.push(chatId); return {}; },
    async sendTextToChat() { return {}; },
    async sendTextToUser() { return {}; },
  },
};

const config = require('../src/config');
const policy = require('../src/services/policyService');
const assistant = require('../src/services/assistantService');
const app = require('../src/index');

let failed = 0;
function check(desc, cond, detail = '') {
  if (cond) console.log(`✓ ${desc}`);
  else { failed += 1; console.error(`❌ ${desc}${detail ? ` —— ${detail}` : ''}`); }
}

(async () => {
  // ① 配置装载
  check('配置装载：DUTY_GROUP_CHAT_IDS 解析为管辖列表',
    JSON.stringify(config.jurisdiction.groupChatIds) === JSON.stringify(['oc_managed_a', 'oc_managed_b']),
    JSON.stringify(config.jurisdiction.groupChatIds));

  // ② 策略结构（管辖范畴 + 生效范畴 + p2p 指令清单）
  const p = policy.getPolicy();
  check('策略：管辖范畴即配置列表', JSON.stringify(p.groupChatIds) === JSON.stringify(['oc_managed_a', 'oc_managed_b']));
  check('策略：生效范畴齐备（看板触发词/指令关闭/关键词放行/引导语）',
    p.hubEnforcement.groupBoardCommand === '值日助手'
    && p.hubEnforcement.closeBasicCommands === true
    && typeof p.hubEnforcement.fallbackGuidance === 'string' && p.hubEnforcement.fallbackGuidance.includes('值日助手'));
  check('策略：p2p 指令清单 10 核心词（含打卡/打卡了/请假确认两步）+8 打卡口语变体 +10 斜杠别名 +快递助手 6 词 +取件词形 + 绑定前缀',
    p.p2pCommands.length === 37
    && ['快递助手', '快递', '查询当前快递', '已取', '全部已取', '确认全部已取', '/快递助手', '/快递', '/查询当前快递'].every((w) => p.p2pCommands.includes(w))
    && Array.isArray(p.p2pCommandPatterns) && p.p2pCommandPatterns.includes('^已取\\s*\\d*$')
    && p.p2pCommandPatterns.includes('^全部已取$') && p.p2pCommandPatterns.includes('^确认全部已取$')
    && Array.isArray(p.groupCommands) && p.groupCommands.includes('快递') && p.groupCommands.includes('值日助手')
    && p.express && p.express.enabled === true
    && ['打卡', '打卡了', '/打卡', '/打卡了'].every((w) => p.p2pCommands.includes(w))
    && ['是的', '好', '好了', '完成', '完成了', '做完了', '搞定', '搞定了'].every((w) => p.p2pCommands.includes(w))
    // 请假二次确认词形随 2026-09-24 新增（裸词 + 斜杠别名都要放行）
    && ['确认请假', '取消请假', '/确认请假', '/取消请假'].every((w) => p.p2pCommands.includes(w))
    && JSON.stringify(p.p2pCommandPrefixes) === JSON.stringify(['绑定', '/绑定']),
    JSON.stringify(p.p2pCommands));

  // ③ 管辖判定
  check('管辖判定：管辖群命中', policy.isManagedGroup('oc_managed_a') && policy.isManagedGroup('oc_managed_b'));
  check('管辖判定：非管辖群拒绝', !policy.isManagedGroup('oc_other'));

  // ④ 群看板的管辖校验（duty-bot 自身防御直调）
  const rejected = await assistant.handleCommand({ command: '值日助手', chatType: 'group', chatId: 'oc_other' });
  check('非管辖群请求看板 → 静默拒绝（不出卡）',
    rejected.handled === true && rejected.reply === '' && !cardsSent.includes('oc_other'));

  // ③.5 gateTask 同名合并（2026-09-27 补断言）：静默窗口内同名任务只保留最新槽位、
  // 异名互不影响——否则整点类任务在窗口内逐小时堆积，冲刷连发多遍
  const quietHours = require('../src/utils/quietHours');
  check('闸门前置：当前处于测试静默窗口', quietHours.inQuietHours());
  await quietHours.gateTask('test_merge_task', 'slot-1', async () => {}, '合并测试1');
  await quietHours.gateTask('test_merge_task', 'slot-2', async () => {}, '合并测试2');
  await quietHours.gateTask('test_other_task', 'slot-1', async () => {}, '合并测试其他');
  const backlogItems = JSON.parse(fs.readFileSync(process.env.QUIET_BACKLOG_FILE, 'utf-8')).items;
  check('gateTask 同名合并：同名只留最新槽位，异名互不影响',
    backlogItems.filter((it) => it.type === 'task' && it.name === 'test_merge_task').length === 1
    && backlogItems.find((it) => it.name === 'test_merge_task').fireKey === 'slot-2'
    && backlogItems.some((it) => it.name === 'test_other_task'),
    JSON.stringify(backlogItems));
  fs.rmSync(process.env.QUIET_BACKLOG_FILE, { force: true });

  // ③.6 失败自动重试与补报（2026-10-07 v47，10-05 断网静默丢提醒事故的回归）：
  // 非静默直跑失败 → 登记积压按递增间隔重试；重试耗尽 → 转失败账目；
  // notifier 补报成功 → 清账。fresh-require 加载（QUIET_HOURS_DISABLED=1 + 毫秒级重试参数）
  {
    process.env.QUIET_HOURS_DISABLED = '1'; // 直跑路径需要非静默
    process.env.QUIET_RETRY_MAX_ATTEMPTS = '3';
    process.env.QUIET_RETRY_BASE_MS = '10';
    delete require.cache[require.resolve('../src/utils/quietHours')];
    const qh2 = require('../src/utils/quietHours');
    check('重试环境：静默已关闭（直跑路径生效）', qh2.inQuietHours() === false);

    qh2.registerTask('test_gate_fail', async () => {});
    let threw = false;
    try {
      await qh2.gateTask('test_gate_fail', 'k1', async () => { throw new Error('模拟网络抖动'); }, '重试直跑');
    } catch (err) {
      threw = true;
    }
    const afterGateFail = JSON.parse(fs.readFileSync(process.env.QUIET_BACKLOG_FILE, 'utf-8')).items;
    check('gateTask 执行失败：错误照抛 + 积压登记待重试',
      threw && afterGateFail.some((it) => it.name === 'test_gate_fail' && it.lastError === '模拟网络抖动'),
      JSON.stringify(afterGateFail));
    await new Promise((r) => setTimeout(r, 80)); // 10ms 重试定时器自动跑成功 runner → 清积压
    check('gateTask 执行失败：重试成功后积压清空',
      !fs.existsSync(process.env.QUIET_BACKLOG_FILE)
        || JSON.parse(fs.readFileSync(process.env.QUIET_BACKLOG_FILE, 'utf-8')).items.length === 0);

    // 重试中间成功：attempts=1 的任务第一次冲刷失败、按退避间隔重跑成功
    let flakyRuns = 0;
    qh2.registerTask('test_flaky_task', async () => {
      flakyRuns += 1;
      if (flakyRuns === 1) throw new Error('第一次失败');
    });
    fs.writeFileSync(process.env.QUIET_BACKLOG_FILE, JSON.stringify({
      items: [{ type: 'task', name: 'test_flaky_task', fireKey: 'f1', attempts: 1 }],
      failures: [],
    }));
    await qh2.runFlush();
    await new Promise((r) => setTimeout(r, 80));
    check('自动重试：失败后按退避间隔重跑成功、积压清空',
      flakyRuns >= 2
        && (!fs.existsSync(process.env.QUIET_BACKLOG_FILE)
          || JSON.parse(fs.readFileSync(process.env.QUIET_BACKLOG_FILE, 'utf-8')).items.length === 0),
      JSON.stringify({ flakyRuns }));

    // 重试耗尽：转失败账目（不静默丢弃）
    qh2.registerTask('test_dead_task', async () => { throw new Error('持续断网'); });
    fs.writeFileSync(process.env.QUIET_BACKLOG_FILE, JSON.stringify({
      items: [{ type: 'task', name: 'test_dead_task', fireKey: 'd1', attempts: 2 }],
      failures: [],
    }));
    await qh2.runFlush();
    const exhausted = JSON.parse(fs.readFileSync(process.env.QUIET_BACKLOG_FILE, 'utf-8'));
    check('重试耗尽：转入失败账目（items 清空、failures 有记录）',
      exhausted.items.length === 0 && exhausted.failures.length === 1
        && exhausted.failures[0].name === 'test_dead_task' && exhausted.failures[0].attempts === 3,
      JSON.stringify(exhausted));
    const reported = [];
    qh2.registerFailureNotifier(async (failures) => { reported.push(...failures); });
    await qh2.maybeReportFailures();
    const afterReport = fs.existsSync(process.env.QUIET_BACKLOG_FILE)
      ? JSON.parse(fs.readFileSync(process.env.QUIET_BACKLOG_FILE, 'utf-8'))
      : { items: [], failures: [] };
    check('失败补报：notifier 收到账目且补报成功后清账',
      reported.length === 1 && reported[0].name === 'test_dead_task'
        && (afterReport.failures || []).length === 0,
      JSON.stringify({ reported, afterReport }));

    delete process.env.QUIET_HOURS_DISABLED;
    delete process.env.QUIET_RETRY_MAX_ATTEMPTS;
    delete process.env.QUIET_RETRY_BASE_MS;
    fs.rmSync(process.env.QUIET_BACKLOG_FILE, { force: true });
  }

  const managed = await assistant.handleCommand({ command: '值日助手', chatType: 'group', chatId: 'oc_managed_a' });
  check('管辖群请求看板 → 正常出卡（限流内首发）',
    managed.handled === true && cardsSent.includes('oc_managed_a'), JSON.stringify({ managed, cardsSent }));

  // ⑤ HTTP 端点下发
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/duty/policy`);
  const body = await res.json();
  check('HTTP /api/duty/policy → 200 且结构与直调一致',
    res.status === 200 && JSON.stringify(body.groupChatIds) === JSON.stringify(p.groupChatIds)
      && body.hubEnforcement.groupBoardCommand === '值日助手',
    JSON.stringify(body));
  server.close();

  console.log(failed === 0 ? `\n全部通过 ✅（临时目录 ${TMP}）` : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
