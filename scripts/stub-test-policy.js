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
process.env.QUIET_HOURS_DISABLED = '1';
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
  check('策略：p2p 指令清单 8 核心词（含打卡/打卡了）+8 打卡口语变体（裸词）+8 斜杠别名 + 绑定前缀',
    p.p2pCommands.length === 24
    && ['打卡', '打卡了', '/打卡', '/打卡了'].every((w) => p.p2pCommands.includes(w))
    && ['是的', '好', '好了', '完成', '完成了', '做完了', '搞定', '搞定了'].every((w) => p.p2pCommands.includes(w))
    && JSON.stringify(p.p2pCommandPrefixes) === JSON.stringify(['绑定', '/绑定']),
    JSON.stringify(p.p2pCommands));

  // ③ 管辖判定
  check('管辖判定：管辖群命中', policy.isManagedGroup('oc_managed_a') && policy.isManagedGroup('oc_managed_b'));
  check('管辖判定：非管辖群拒绝', !policy.isManagedGroup('oc_other'));

  // ④ 群看板的管辖校验（duty-bot 自身防御直调）
  const rejected = await assistant.handleCommand({ command: '值日助手', chatType: 'group', chatId: 'oc_other' });
  check('非管辖群请求看板 → 静默拒绝（不出卡）',
    rejected.handled === true && rejected.reply === '' && !cardsSent.includes('oc_other'));

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
