const express = require('express');
const { requireApiToken } = require('./auth');
const cors = require('cors');
const config = require('./config');
const roster = require('./services/rosterService');
const state = require('./services/stateStore');
const assistant = require('./services/assistantService');
const expressService = require('./services/expressService');
const policy = require('./services/policyService');
const scheduleService = require('./services/scheduleService');
const inquiry = require('./services/inquiryService');
const compensation = require('./services/compensationService');
const quietHours = require('./utils/quietHours');
const { startCronJobs, runClose, getCronStatus } = require('./cron');

const app = express();

app.use(cors());
// hub 转发的指令载荷与后续图片 base64 场景可能较大，放宽 body 限制
app.use(express.json({ limit: '2mb' }));

// ---------- 健康检查 ----------

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    port: config.port,
    quietHours: quietHours.getStatus(),
  });
});

// ---------- 指令转发端点（approval-bot / bambu 同款契约，hub 调用） ----------
// 请求体：
//   文本指令 {command, openId, chatType:'p2p'|'group', chatId?, messageId?, args?}
//   图片载荷 {type:'image', openId, imageKey, messageId}
// 返回：{reply}；reply 为空串表示已自行处理（如群看板卡片），hub 可跳过发送

// 消息级幂等（webhook/网关重投防双计：同一句「我要请假」触发两次会双倍登记补偿义务）
const seenMessages = new Map(); // messageId -> firstSeenAt
const SEEN_TTL_MS = 10 * 60 * 1000;
function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [k, t] of seenMessages) {
    if (now - t > SEEN_TTL_MS) seenMessages.delete(k);
  }
  if (seenMessages.has(messageId)) return true;
  seenMessages.set(messageId, now);
  return false;
}

app.post('/api/chat/command', async (req, res) => {
  try {
    const body = req.body || {};

    if (isDuplicateMessage(body.messageId)) {
      console.log('[指令] 重复消息已忽略:', body.messageId);
      return res.json({ reply: '' });
    }

    if (body.type === 'express_observe') {
      // 快递登记窗口观察（hub 对快递群非@消息的转发；无窗口静默忽略）
      const result = await expressService.observe(body);
      return res.json({ reply: result.reply || '' });
    }

    if (body.type === 'image') {
      const result = await assistant.handleImagePayload(body);
      return res.json({ reply: result.reply || '' });
    }

    if (!body.command) {
      return res.status(400).json({ error: '指令不能为空' });
    }

    const result = await assistant.handleCommand(body);
    res.json({ reply: result.reply || '' });
  } catch (err) {
    console.error('处理转发指令失败:', err);
    res.json({ reply: `❌ 指令执行失败：${err.message}` });
  }
});

// ---------- 管辖策略（hub 值日分支判定依据，短缓存消费） ----------
// 权限管辖范畴（哪些群）与生效范畴（群里放行什么）的单一事实来源在本项目；
// hub 据此判定值日管辖群并代为执行放行规则，duty-bot 仍不消费消息事件。

app.get('/api/duty/policy', (req, res) => {
  res.json(policy.getPolicy());
});

// 管辖范畴在线改写（定制窗口写入口）：{ groupChatIds: ["oc_..."] }（空数组 = 不限制）
app.post('/api/duty/policy', requireApiToken, (req, res) => {
  const ids = req.body?.groupChatIds;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'groupChatIds 必须是数组' });
  const clean = ids.map((s) => String(s).trim()).filter(Boolean);
  policy.saveOverride({ groupChatIds: clean });
  console.log(`[管辖策略] 在线改写：管辖群 ${clean.length} 个`);
  res.json({ ok: true, policy: policy.getPolicy() });
});

// ---------- 定制窗口（名册/白名单附属管理，规则见顶层 AGENTS「机器人后端定制窗口」） ----------

// 名册全景（通讯录同步结果 + 绑定/白名单/队列状态）
app.get('/api/duty/roster', (req, res) => {
  const members = roster.getMembers();
  const whitelist = new Set(roster.loadWhitelistNames());
  const items = members.map((m) => ({
    name: m.name,
    dept: m.dept || '',
    admin: !!m.admin,
    bound: !!m.openId,
    whitelisted: whitelist.has(m.name),
    inQueue: !whitelist.has(m.name),
  }));
  res.json({
    total: items.length,
    queue: items.filter((i) => i.inQueue).length,
    bound: items.filter((i) => i.bound).length,
    members: items,
  });
});

// 手动触发通讯录同步（启动/生成排班前也会自动同步）
app.post('/api/duty/roster/refresh', requireApiToken, async (req, res) => {
  try {
    const members = await roster.syncFromContacts();
    res.json({ success: true, total: members.length });
  } catch (err) {
    console.error('[名册] 手动同步失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 白名单（值日排除名单）查看与增删
app.get('/api/duty/whitelist', (req, res) => {
  res.json({ names: roster.loadWhitelistNames() });
});

app.post('/api/duty/whitelist', requireApiToken, (req, res) => {
  const { add = [], remove = [] } = req.body || {};
  const names = roster.updateWhitelist({ add, remove });
  res.json({ success: true, names });
});

// ---------- 对外数据接口（通用值日简报数据接口，保留备用） ----------
// { yesterday: {date, dayStatus, members:[{name, position, status, hasReceipt}]},
//   today: {date, members:[{name, position}]} }

app.get('/api/duty/brief', async (req, res) => {
  try {
    res.json(await scheduleService.getBrief());
  } catch (err) {
    console.error('获取值日简报失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 手动触发接口（测试/运维用；人工当下主动触发不受静默限制） ----------

app.post('/api/bot/test-remind', requireApiToken, async (req, res) => {
  try {
    res.json({ success: true, result: await inquiry.sendPrevDayRemind({ dryRun: !!req.body?.dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/test-ask', requireApiToken, async (req, res) => {
  try {
    res.json({ success: true, result: await inquiry.askToday({ dryRun: !!req.body?.dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 收口前临门提醒（手动触发不受静默限制；dryRun 只回预览）
app.post('/api/bot/test-lastcall', requireApiToken, async (req, res) => {
  try {
    res.json({ success: true, result: await inquiry.sendLastCall({ dryRun: !!req.body?.dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/test-close', requireApiToken, async (req, res) => {
  try {
    // 手动触发不受静默限制（bypassQuiet：回执直接发送，不落积压）
    res.json({ success: true, result: await runClose({ dryRun: !!req.body?.dryRun, bypassQuiet: true }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/test-reconcile', requireApiToken, async (req, res) => {
  try {
    res.json({ success: true, result: await compensation.reconcile({ dryRun: !!req.body?.dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 排班生成（默认 dryRun 只出预览；带 {"confirm":true} 才正式写表。
// 正式生成建议仍由管理员私信触发，这里主要作预览/核对用）
app.post('/api/bot/test-generate', requireApiToken, async (req, res) => {
  try {
    const dryRun = !req.body?.confirm;
    const result = await scheduleService.generate({ dryRun });
    res.json({ success: true, reply: scheduleService.renderGenerateReply(result), result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 看板自动播报（与 12:00 cron 同一执行链；默认 dryRun 只预览，{"confirm":true} 才实发。
// 人工当下触发不走静默闸门，与其它 test-* 口径一致）
app.post('/api/bot/test-board', requireApiToken, async (req, res) => {
  try {
    const dryRun = !req.body?.confirm;
    res.json({ success: true, result: await assistant.broadcastTodayBoard({ dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bot/cron-status', (req, res) => {
  res.json(getCronStatus());
});

// ---------- 启动 ----------

function startServer() {
  const server = app.listen(config.port, () => {
    console.log(`🚀 值日提醒机器人运行在 http://localhost:${config.port}`);
    console.log(`🩺 健康检查: http://localhost:${config.port}/api/health`);
    console.log(`📋 值日简报: http://localhost:${config.port}/api/duty/brief`);
    console.log(`🧹 管辖策略: http://localhost:${config.port}/api/duty/policy (管辖群 ${config.jurisdiction.groupChatIds.length || '不限'} 个)`);
  });

  roster.validateStartup();
  state.load(); // 启动即确保状态目录存在（DUTY_STATE_FILE / QUIET_BACKLOG_FILE 同目录场景）
  startCronJobs();

  // 启动即同步通讯录名册（失败沿用本地名册，不阻断启动；同步后再校验一次输出准确人数）
  roster.syncFromContacts()
    .then(() => roster.validateStartup())
    .catch((err) => {
      console.error('[名册] 通讯录同步失败（沿用本地名册）:', err.message);
      roster.validateStartup();
    });

  process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = app;
