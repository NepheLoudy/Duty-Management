const express = require('express');
const cors = require('cors');
const config = require('./config');
const roster = require('./services/rosterService');
const state = require('./services/stateStore');
const assistant = require('./services/assistantService');
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

// ---------- 对外数据接口（pm-robot 每日值日播报数据源） ----------
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

app.post('/api/bot/test-remind', async (req, res) => {
  try {
    res.json({ success: true, result: await inquiry.sendPrevDayRemind({ dryRun: !!req.body?.dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/test-ask', async (req, res) => {
  try {
    res.json({ success: true, result: await inquiry.askToday({ dryRun: !!req.body?.dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/test-close', async (req, res) => {
  try {
    // 手动触发不受静默限制（bypassQuiet：回执直接发送，不落积压）
    res.json({ success: true, result: await runClose({ dryRun: !!req.body?.dryRun, bypassQuiet: true }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/test-reconcile', async (req, res) => {
  try {
    res.json({ success: true, result: await compensation.reconcile({ dryRun: !!req.body?.dryRun }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 排班生成（默认 dryRun 只出预览；带 {"confirm":true} 才正式写表。
// 正式生成建议仍由管理员私信触发，这里主要作预览/核对用）
app.post('/api/bot/test-generate', async (req, res) => {
  try {
    const dryRun = !req.body?.confirm;
    const result = await scheduleService.generate({ dryRun });
    res.json({ success: true, reply: scheduleService.renderGenerateReply(result), result });
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
