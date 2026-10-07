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

// 消息级幂等（webhook/网关重投防双计：同一句「我要请假」触发两次会双倍登记补偿义务）。
// 去重键 = messageId + 载荷类型：hub 对快递群图文混合消息拆两次转发（取件码文字 +
// 照片载荷）且带同一 messageId——裸 messageId 去重会把第二次当重投丢弃（照片必丢）；
// 同载荷类型的网关重投仍被拦。express 登记端另有表级 messageId 去重兜底，此处为消息级双保险。
const seenMessages = new Map(); // "messageId:kind" -> firstSeenAt
const SEEN_TTL_MS = 10 * 60 * 1000;
function isDuplicateMessage(messageId, kind) {
  if (!messageId) return false;
  const key = `${messageId}:${kind || 'command'}`;
  const now = Date.now();
  for (const [k, t] of seenMessages) {
    if (now - t > SEEN_TTL_MS) seenMessages.delete(k);
  }
  if (seenMessages.has(key)) return true;
  seenMessages.set(key, now);
  return false;
}

app.post('/api/chat/command', async (req, res) => {
  try {
    const body = req.body || {};

    if (isDuplicateMessage(body.messageId, body.type)) {
      console.log('[指令] 重复消息已忽略:', body.messageId, body.type || 'command');
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

// 提前预告手动触发（2026-10-07 起 D-7/D-3 通用：body 可带 {"daysAhead":3}，缺省 7；dryRun 只回预览）
app.post('/api/bot/test-week-remind', requireApiToken, async (req, res) => {
  try {
    res.json({ success: true, result: await inquiry.sendAheadRemind({ dryRun: !!req.body?.dryRun, daysAhead: req.body?.daysAhead }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 当日中午提醒手动触发（2026-10-07 v46；dryRun 只回预览，非 dryRun 会开启当日监听会话）
app.post('/api/bot/test-noon-remind', requireApiToken, async (req, res) => {
  try {
    res.json({ success: true, result: await inquiry.sendNoonRemind({ dryRun: !!req.body?.dryRun }) });
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

// 排班重排（2026-09-25 检修）：清理未来未完成班次并重新生成（每天严格 3 人）。
// 默认预览删除/义务重置清单；body {"confirm":true} 才执行（先自动全量备份到数据目录 backup/）
app.post('/api/bot/rebalance', requireApiToken, async (req, res) => {
  try {
    const result = await scheduleService.rebalance({ confirm: !!req.body?.confirm });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[重排] 失败:', err.message);
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

// ============================================================
// ZKLink 打卡时长周报（2026-10-07 v48 归并，src/zklink/）
// 每周一 09:30 上海统计上周打卡时长 → 值日群 webhook 周报卡 + 云文档留档。
// 不消费消息事件；端点挂本服务 :3006（鉴权复用 API_TOKEN）。
// ============================================================
const zklinkConfig = require('./zklink/config');
const zklinkStore = require('./zklink/store');
const zklinkClient = require('./zklink/zklinkClient');
const zklinkReport = require('./zklink/report');
const zklinkImport = require('./zklink/importService');
const zklinkFeishuDoc = require('./zklink/feishuDoc');
const zklinkCard = require('./zklink/card');
const zklinkService = require('./zklink/service');
const quietHoursZk = require('./utils/quietHours');

// ---- 定制窗口：打卡域政策全景只读 ----
app.get('/api/attendance/policy', (req, res) => {
  const win = zklinkReport.weekWindow(0, Date.now(), zklinkConfig.cronParts.dow == null ? 1 : zklinkConfig.cronParts.dow);
  let imported = null;
  let stateSummary = {};
  try {
    const st = zklinkStore.loadState();
    const { records, members, ...meta } = st.imported || {};
    imported = Object.keys(meta).length ? { ...meta, records: (records || []).length } : null;
    stateSummary = {
      lastSentWeekKey: st.lastSentWeekKey || null,
      lastArchivedWeekKey: st.lastArchivedWeekKey || null,
      lastSentAt: st.lastSentAt || null,
      lastError: st.lastError || null,
      delivery: st.delivery || null,
      imported,
      members: (st.members || []).length,
    };
  } catch { /* 状态文件损坏时窗口仍可用，摘要留空 */ }
  res.json({
    domain: 'ZKLink 打卡时长周报（值日群，归并 duty-bot）',
    broadcast: {
      cron: zklinkConfig.cron,
      timezone: zklinkConfig.timezone,
      windowLabel: win.label,
      windowKey: win.key,
      quietHours: quietHoursZk.getStatus(),
    },
    dataSource: zklinkConfig.dataSource,
    dataSourceDocs: 'feishu=飞书考勤 API 全自动（推荐，需 attendance+contact employee_id 权限）；import=ZKLink 网页端导出上传；http=ZKLink 接口直拉（仅独立账密账号）',
    zklink: {
      baseUrl: zklinkConfig.zklinkBaseUrl,
      usernameConfigured: !!zklinkConfig.zklinkUsername,
      attGroupId: zklinkConfig.zklinkAttGroupId || null,
      loginPath: zklinkConfig.zklinkLoginPath,
      transactionPath: zklinkConfig.zklinkTransactionPath,
      httpUsable: zklinkClient.isConfigured(),
      apiDocs: '端点为候选值：凭据到位后跑 node scripts/zklink-probe.js 校准回填，再切 ZKLINK_DATA_SOURCE=http',
    },
    channels: {
      feishu: !!zklinkConfig.webhookUrl,
      webhookSource: process.env.ZKLINK_WEBHOOK_URL ? 'ZKLINK_WEBHOOK_URL' : 'DUTY_BOARD_WEBHOOK_URL（复用值日看板同一条）',
    },
    archive: {
      appConfigured: zklinkConfig.appConfigured,
      docConfigured: !!(zklinkConfig.appConfigured && zklinkConfig.archiveDocToken),
      archiveDir: zklinkConfig.archiveDir,
      exportsDir: zklinkConfig.exportsDir,
      apiDocs: 'ZKLINK_ARCHIVE_DOC_TOKEN 支持 wiki 节点 token（自动 get_node 换算）或 docx token；应用需 docx 权限且被加为文档协作者',
    },
    state: stateSummary,
    apiTokenLocked: !process.env.API_TOKEN,
  });
});

// ---- 打卡域成员增删（X-API-Token；名单在打卡 state 内，导入自动合并） ----
app.post('/api/attendance/members', requireApiToken, (req, res) => {
  const { action, userid, name } = req.body || {};
  const { list, error } = zklinkStore.applyMembersChange({ action, userid, name });
  if (error) return res.status(400).json({ error });
  res.json({ ok: true, count: list.length, list });
});

// ---- 打卡明细导入（POST {dataBase64, filename?}；名单自动合并进打卡 state） ----
app.post('/api/attendance/import', requireApiToken, (req, res) => {
  const { dataBase64, filename } = req.body || {};
  if (!dataBase64) return res.status(400).json({ error: '缺少 dataBase64（打卡明细文件字节流的 base64）' });
  const b64 = String(dataBase64).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    return res.status(400).json({ error: 'dataBase64 非法 base64' });
  }
  const buf = Buffer.from(b64, 'base64');
  try {
    const parsed = zklinkImport.parseWorkbook(buf);
    const merged = zklinkImport.mergeMembers(zklinkStore.loadMembers(), parsed.members);
    zklinkStore.mergeSaveState({ members: merged });
    const st = zklinkStore.loadState();
    // 覆盖天数按上海挂钟日（report.js toWall 口径）：UTC 直取会把上海 00:00–07:59 的打卡算到前一天
    const days = [...new Set(parsed.records.map((r) => new Date(r.checkin_time * 1000 + zklinkReport.SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)))].sort();
    st.imported = { records: parsed.records, importedAt: new Date().toISOString(), sourceFile: String(filename || ''), count: parsed.records.length, days: `${days[0]} ~ ${days[days.length - 1]}` };
    zklinkStore.saveState(st);
    console.log(`[打卡周报] 导入打卡明细: ${parsed.records.length} 条（${st.imported.days}），名单 ${merged.length} 人`);
    res.json({ ok: true, count: parsed.records.length, days: st.imported.days, members: merged.length, columnsMatched: parsed.matched, skipped: parsed.skipped });
  } catch (err) {
    console.error('[打卡周报] 导入解析失败:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ---- 干跑预览（含云文档留档块数预览） ----
app.get('/api/attendance/preview', async (req, res) => {
  const offset = Number(req.query.weekOffset || 0) || 0;
  try {
    const r = await zklinkService.runWeekly({ offset, dryRun: true });
    const docBlocks = zklinkFeishuDoc.buildDocBlocks(r.window, r.agg, r.agg.rawRecords, {});
    res.json({
      ok: true,
      window: r.window.label,
      totals: r.totals,
      cardMarkdown: zklinkCard.buildWeeklyCard(r.window, r.agg).elements[0].content,
      userLines: zklinkReport.renderUserLines(r.agg),
      csvPreview: r.csv.split('\r\n').slice(0, 6),
      docBlocksPreview: { count: docBlocks.length, head: docBlocks.slice(0, 6).map((b) => (b.text ? b.text.elements[0].text_run.content : `heading#${b.block_type - 2}`)) },
    });
  } catch (err) {
    res.status(err.errcode === 'NO_CONFIG' ? 503 : 502).json({ error: err.message, hint: err.hint || null });
  }
});

// ---- 手动播报+留档（真发/dryRun，X-API-Token；当下主动触发不受静默限制） ----
app.post('/api/attendance/test-broadcast', requireApiToken, async (req, res) => {
  const { weekOffset = 0, dryRun = false } = req.body || {};
  try {
    const r = await zklinkService.guardedRun({ offset: Number(weekOffset) || 0, dryRun: !!dryRun, trigger: 'manual' });
    res.json({ ok: true, sent: r.sent, window: r.window.label, totals: r.totals, filename: r.filename });
  } catch (err) {
    res.status(err.errcode === 'NO_CONFIG' ? 503 : 502).json({ error: err.message, hint: err.hint || null });
  }
});

// ---------- 启动 ----------

function startServer() {
  // 仅回环监听（2026-09-27）：消费方（hub 指令转发/gateway/本地运维台 SSH 代理）都在本机，
  // 不对局域网暴露端口；需要跨机访问走隧道，不在此开全网卡
  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log(`🚀 值日提醒机器人运行在 http://127.0.0.1:${config.port}（仅回环监听，消费方均在本机）`);
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
