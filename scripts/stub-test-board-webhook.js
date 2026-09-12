/**
 * 看板 webhook 通道 stub 测试（stub：临时状态文件 + 本地 http 服务/mock 发送层）
 * 覆盖：webhook 发送层（payload 形状、签名、错误路径、旧版 StatusCode）、
 *      handleGroupBoard 通道选择（配置 webhook 走 webhook / 未配置回退 im API）、
 *      限流与卡片复用不受通道切换影响、自动播报通道回退（未配置/推送失败 → 应用身份直发）。
 * 运行：npm run test:board
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// ---- 环境隔离（必须在 require 任何 src 模块前设置） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-bot-board-test-'));
process.env.QUIET_HOURS_DISABLED = '1';
process.env.DUTY_STATE_FILE = path.join(TMP, 'state.json');
process.env.DUTY_MEMBERS_FILE = path.join(TMP, 'members.json');
process.env.DUTY_WHITELIST_FILE = path.join(TMP, 'whitelist.json');
fs.writeFileSync(process.env.DUTY_MEMBERS_FILE, JSON.stringify({ members: [{ name: '队员A', openId: 'ou_test_a', admin: true }] }));
fs.writeFileSync(process.env.DUTY_WHITELIST_FILE, JSON.stringify({ names: [] }));
process.env.DUTY_GROUP_CHAT_IDS = 'oc_managed_a';
process.env.DUTY_BOARD_WEBHOOK_URL = 'https://board.example.invalid/hook';
process.env.DUTY_BOARD_WEBHOOK_SECRET = 'testsecret';

const config = require('../src/config');
const realWebhook = require('../src/feishu/webhook');

let failed = 0;
function check(desc, cond, detail = '') {
  if (cond) console.log(`✓ ${desc}`);
  else { failed += 1; console.error(`❌ ${desc}${detail ? ` —— ${detail}` : ''}`); }
}

// ---- 本地 http 服务：按 mode 应答，记录最近一次请求体 ----
let mode = 'ok'; // ok | legacy | fail | nonjson
let lastBody = null;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { lastBody = JSON.parse(raw); } catch (err) { lastBody = null; }
    if (mode === 'fail') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 19021, msg: 'sign match fail' }));
    } else if (mode === 'legacy') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ StatusCode: 0, StatusMessage: 'success' }));
    } else if (mode === 'nonjson') {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end('<html>bad gateway</html>');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'success' }));
    }
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${server.address().port}/hook`;
  const card = { header: { title: { content: '🧹 今日值日看板', tag: 'plain_text' } }, elements: [] };

  // ① 配置装载
  check('配置装载：DUTY_BOARD_WEBHOOK_URL/SECRET 解析进 board 段',
    config.board.webhookUrl === 'https://board.example.invalid/hook' && config.board.webhookSecret === 'testsecret');

  // ② webhook 发送层：payload 形状 + 签名
  mode = 'ok';
  await realWebhook.sendCardToWebhook(hookUrl, 'testsecret', card);
  check('payload：msg_type=interactive 且卡片结构原样挂在 card 字段',
    lastBody && lastBody.msg_type === 'interactive'
    && lastBody.card && lastBody.card.header.title.content === '🧹 今日值日看板');
  const expectedSign = crypto.createHmac('sha256', `${lastBody.timestamp}\n${'testsecret'}`).update('').digest('base64');
  check('签名：开启密钥时附 timestamp/sign 且符合飞书签名规则',
    typeof lastBody.timestamp === 'string' && lastBody.sign === expectedSign, JSON.stringify(lastBody || {}));

  await realWebhook.sendCardToWebhook(hookUrl, '', card);
  check('无密钥：不带 timestamp/sign',
    lastBody && !('timestamp' in lastBody) && !('sign' in lastBody));

  // ③ 错误路径
  mode = 'fail';
  let threw = '';
  try { await realWebhook.sendCardToWebhook(hookUrl, '', card); } catch (err) { threw = err.message; }
  check('code!=0 → 抛可读错误', threw.includes('webhook 发送失败') && threw.includes('19021'), threw);
  mode = 'nonjson';
  threw = '';
  try { await realWebhook.sendCardToWebhook(hookUrl, '', card); } catch (err) { threw = err.message; }
  check('非 JSON 响应 → 抛可读错误', threw.includes('非 JSON 响应'), threw);
  mode = 'legacy';
  const legacy = await realWebhook.sendCardToWebhook(hookUrl, '', card);
  check('旧版 StatusCode=0 视为成功', legacy && legacy.StatusCode === 0);

  // ---- 注入捕获层，再加载 assistantService（必须在首次 require 前替换缓存） ----
  const webhookCalls = [];
  let webhookFailMode = false;
  require.cache[require.resolve('../src/feishu/webhook')] = {
    id: 'webhook-stub', filename: 'webhook-stub', loaded: true,
    exports: {
      async sendCardToWebhook(url, secret, cardContent) {
        if (webhookFailMode) throw new Error('webhook 发送失败（模拟）');
        webhookCalls.push({ url, secret, title: cardContent.header.title.content });
        return {};
      },
    },
  };
  const chatCards = [];
  require.cache[require.resolve('../src/feishu/bot')] = {
    id: 'bot-stub', filename: 'bot-stub', loaded: true,
    exports: {
      async sendCardToChat(chatId) { chatCards.push(chatId); return {}; },
      async sendTextToChat() { return {}; },
      async sendTextToUser() { return {}; },
    },
  };
  require.cache[require.resolve('../src/services/dutyTableService')] = {
    id: 'dutyTable-stub', filename: 'dutyTable-stub', loaded: true,
    exports: {
      async getRecordsByDate() {
        return stubRecords;
      },
      computeDayStatus() { return '今日完成值日'; },
    },
  };
  let stubRecords = ['总负责', '工位区', '装配区'].map((pos) => ({
    position: pos, name: '队员A', status: '已做完',
    receiptCounts: { '总负责': 1, '工位区': 0, '装配区': 0 },
  }));

  const assistant = require('../src/services/assistantService');

  // ④ 配置 webhook 时走 webhook 通道，不回退 im API
  const first = await assistant.handleGroupBoard('oc_managed_a');
  check('已配置 webhook → 看板走群自定义机器人通道（卡片标题复用今日值日看板）',
    first.handled && webhookCalls.length === 1 && chatCards.length === 0
    && webhookCalls[0].url === config.board.webhookUrl && webhookCalls[0].secret === config.board.webhookSecret
    && webhookCalls[0].title === '🧹 今日值日看板',
    JSON.stringify({ first, webhookCalls, chatCards }));

  // ⑤ 限流不受通道影响（同群 1 小时内第二次静默）
  const second = await assistant.handleGroupBoard('oc_managed_a');
  check('命中限流静默（不重复发卡）',
    second.rateLimited === true && webhookCalls.length === 1 && chatCards.length === 0);

  // ⑥ 未配置 webhook → 回退应用身份 im API
  config.board.webhookUrl = '';
  const fallback = await assistant.handleGroupBoard('oc_other_fallback');
  check('未配置 webhook → 回退 sendCardToChat（不再走 webhook）',
    fallback.handled && chatCards.includes('oc_other_fallback') && webhookCalls.length === 1,
    JSON.stringify({ fallback, chatCards }));

  // ⑦ 看板自动播报（与 12:00 cron 同一执行链）
  check('配置装载：DUTY_BOARD_BROADCAST_SCHEDULE 默认 12:00',
    config.schedule.boardBroadcast === '0 0 12 * * *', config.schedule.boardBroadcast);
  config.board.webhookUrl = 'https://board.example.invalid/hook';
  const preview = await assistant.broadcastTodayBoard({ dryRun: true });
  check('自动播报 dryRun：只回预览不发送',
    preview.skipped === false && preview.dryRun === true
    && preview.members.length === 3 && webhookCalls.length === 1,
    JSON.stringify({ preview, webhookCalls: webhookCalls.length }));
  const sent = await assistant.broadcastTodayBoard({});
  check('自动播报：经 webhook 推送今日看板',
    sent.skipped === false && sent.via === 'webhook' && webhookCalls.length === 2,
    JSON.stringify(sent));
  stubRecords = [];
  const empty = await assistant.broadcastTodayBoard({});
  check('自动播报：今日无排班记录自动跳过',
    empty.skipped === true && empty.reason === 'no_records' && webhookCalls.length === 2);

  // ⑧ 播报通道回退：未配置 webhook 或推送失败 → 应用身份直发管辖群（不再静默跳过）
  config.board.webhookUrl = '';
  stubRecords = ['总负责', '工位区', '装配区'].map((pos) => ({
    position: pos, name: '队员A', status: '已做完',
    receiptCounts: { '总负责': 1, '工位区': 0, '装配区': 0 },
  }));
  const nocfg = await assistant.broadcastTodayBoard({});
  check('自动播报：未配置 webhook → 回退应用身份直发管辖群',
    nocfg.skipped === false && nocfg.via === 'app' && nocfg.groups === 1
    && chatCards.includes('oc_managed_a') && webhookCalls.length === 2,
    JSON.stringify({ nocfg, chatCards }));

  webhookFailMode = true;
  const whFail = await assistant.broadcastTodayBoard({});
  webhookFailMode = false;
  check('自动播报：webhook 推送失败 → 同样回退应用身份直发（播报不因通道故障中断）',
    whFail.skipped === false && whFail.via === 'app'
    && chatCards.filter((c) => c === 'oc_managed_a').length === 2,
    JSON.stringify({ whFail, chatCards }));

  // 卡片内容：一个面板同时播昨天今天（2026-09-12 口径）——有昨日数据带「昨日战报」段，无则不带
  {
    const today = require('../src/utils/dates').todayStr();
    const todayRecs = [{ name: '队员A', position: '总负责', status: '待定', receiptCounts: { 总负责: 0, 工位区: 0, 装配区: 0 } }];
    const yRecs = [{ name: '队员A', position: '总负责', status: '已做完', receiptCounts: { 总负责: 2, 工位区: 0, 装配区: 0 } }];
    const withY = assistant.buildBoardCard(today, todayRecs, { date: '2026-09-12', records: yRecs });
    const withoutY = assistant.buildBoardCard(today, todayRecs, null);
    const flat = (card) => card.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('\n');
    check('看板卡：有昨日数据 → 含「昨日战报」段（昨日状态与照片数）',
      flat(withY).includes('昨日（2026-09-12）战报') && flat(withY).includes('已做完') && flat(withY).includes('📎2'),
      flat(withY));
    check('看板卡：无昨日数据 → 不含昨日段',
      !flat(withoutY).includes('昨日（'),
      flat(withoutY));
  }

  server.close();
  console.log(failed === 0 ? `\n全部通过 ✅（临时目录 ${TMP}）` : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试执行异常:', err);
  server.close();
  process.exit(1);
});
