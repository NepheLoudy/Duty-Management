const express = require('express');
const cors = require('cors');
const config = require('./config');
const roster = require('./services/rosterService');
const assistant = require('./services/assistantService');
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
//   文本指令 {command, openId, chatType:'p2p'|'group', chatId?, args?}
//   图片载荷 {type:'image', openId, imageKey, messageId}
// 返回：{reply}；reply 为空串表示已自行处理（如群看板卡片），hub 可跳过发送

app.post('/api/chat/command', async (req, res) => {
  try {
    const body = req.body || {};

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
    res.json({ success: true, result: await runClose({ dryRun: !!req.body?.dryRun }) });
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

// 排班生成（dryRun=true 只出预览不写表；正式生成建议仍由管理员私信触发）
app.post('/api/bot/test-generate', async (req, res) => {
  try {
    const result = await scheduleService.generate({ dryRun: !!req.body?.dryRun });
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
  });

  roster.validateStartup();
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
