const config = require('../config');
const { addDays, todayStr } = require('../utils/dates');
const bot = require('../feishu/bot');
const webhook = require('../feishu/webhook');
const roster = require('./rosterService');
const state = require('./stateStore');
const dutyTable = require('./dutyTableService');
const scheduleService = require('./scheduleService');
const inquiry = require('./inquiryService');
const policy = require('./policyService');
const express = require('./expressService');

// ============================================================
// 值日助手（经 hub 转发的被动指令层，POST /api/chat/command）
// - 私信（精确匹配）：值日助手 / 我要请假 / 查询我的下一次值日 / 绑定 X /
//   是 / 否 / 生成排班表（仅名册 admin）；打卡确认口语变体（是的/完成了 等）
//   在有当日活跃询问会话时等同「是」，无会话静默交还 hub 走常规流程
// - 群聊（@机器人 值日助手）：值日状态看板卡片（今日三岗 + 昨日战报，一个面板同时
//   播昨天今天），每群 1 小时限流一次，命中限流静默；发送通道为群自定义机器人
//   webhook（非对话型），未配置 DUTY_BOARD_WEBHOOK_URL 时回退应用身份 im API 直发
// - 看板自动播报：每日 12:00（cron）经 webhook 推同一张卡
//   （broadcastTodayBoard，/api/bot/test-board 手动触发共用）
// - 图片载荷：{type:'image', openId, imageKey, messageId}
// ============================================================

const HELP_TEXT = [
  '🧹 值日助手用法（指令带不带 / 都可以）：',
  '· 「查询我的下一次值日」—— 下次值日日期与岗位',
  '· 「我要请假」—— 登记请假（当次置已请假，机器人会从较远的排班抽调一人当日补位并私信告知；下周仍自动补插一次值日）',
  '· 「绑定 姓名」—— 首次使用绑定账号（提醒与确认走私信）',
  '· 「打卡」—— 值日日 18:30 询问后回复它完成打卡（口语「是的」「完成了」也可；照片可直接发我，22:00 收口）；「否」= 今天不做了',
  '· 「生成排班表」—— 管理员专用，按日历向下生成一个月排班',
  '',
  '规则：完成后回复「打卡」并上传现场照片（照片写入值日表对应岗位栏）；22:00 收口，未打卡记为未做完。',
  '若你同时收到项目管理 DDL 逾期确认，回复「是」会先去确认那个项目（12 小时内有效）——值日打卡请用「打卡」。',
].join('\n');

/**
 * 值日状态看板卡片（一个面板同时播昨天今天，2026-09-12 口径）：
 * 今日三岗状态 + 昨日战报段（有昨日记录才显示）。
 * @param {string} dateStr 今日日期
 * @param {Array} records 今日记录
 * @param {{date: string, records: Array} | null} yesterday 昨日数据（调用方取好传入，取不到传 null）
 */
function buildBoardCard(dateStr, records, yesterday) {
  const dayStatus = dutyTable.computeDayStatus(records)
    || records.map((r) => r.dayStatus).find(Boolean)
    || null;

  // 按岗位聚合渲染（2026-09-13）：补位/补偿会产生同岗多人（4 人日），
  // 旧 find 只取第一条会隐藏另一人（可能恰是实际顶班者）
  const lineFor = (rec, pos, showPhoto) => {
    const statusText = rec.status || '待定';
    const photoText = showPhoto && (rec.receiptCounts[pos] || 0) > 0 ? ` 📎${rec.receiptCounts[pos]}` : '';
    const unbound = rec.name ? '' : '（未绑定）';
    return `· ${pos}：${rec.name || '（未绑定）'} —— ${statusText}${photoText}${unbound}`;
  };
  const linesForDay = (dayRecords) => ['总负责', '工位区', '装配区'].flatMap((pos) => {
    const recs = dayRecords.filter((r) => r.position === pos);
    if (!recs.length) return [`· ${pos}：（暂无排班）`];
    // 照片挂在岗位栏（同人同岗共用），只在该岗位首行显示一次
    return recs.map((r, i) => lineFor(r, pos, i === 0));
  });

  const lines = linesForDay(records);

  const elements = [
    { tag: 'markdown', content: `**📅 ${dateStr}**　总状态：${dayStatus || '未完成/待定'}` },
    { tag: 'hr' },
    { tag: 'markdown', content: lines.join('\n') },
  ];

  if (yesterday && yesterday.records && yesterday.records.length) {
    const yStatus = dutyTable.computeDayStatus(yesterday.records)
      || yesterday.records.map((r) => r.dayStatus).find(Boolean)
      || null;
    const yLines = linesForDay(yesterday.records);
    elements.push(
      { tag: 'hr' },
      { tag: 'markdown', content: `**🕘 昨日（${yesterday.date}）战报**　总状态：${yStatus || '未完成'}` },
      { tag: 'markdown', content: yLines.join('\n') },
    );
  }

  elements.push(
    { tag: 'hr' },
    { tag: 'markdown', content: '> 排班查询 / 请假 / 打卡确认均在私信办理：私信机器人「值日助手」可查询排班、请假；完成后请私信回复「打卡」并上传照片，22:00 收口。' },
  );

  return {
    config: { wide_screen_mode: true },
    header: {
      template: dayStatus ? 'green' : (records.length ? 'orange' : 'grey'),
      title: { content: '🧹 今日值日看板', tag: 'plain_text' },
    },
    elements,
  };
}

/** 取昨日记录（看板「昨日战报」段数据源；失败/无记录返回 null） */
async function getYesterdaySection() {
  try {
    const yDate = addDays(todayStr(), -1);
    const yRecs = await dutyTable.getRecordsByDate(yDate);
    return yRecs.length ? { date: yDate, records: yRecs } : null;
  } catch (err) {
    console.warn('[看板] 昨日记录读取失败（看板只展示今日）:', err.message);
    return null;
  }
}

/** 群看板（每群 1 小时限流，命中静默；先占限流戳再发卡，避免并发窗口连发两张） */
async function handleGroupBoard(chatId) {
  if (!chatId) return { handled: false, reply: '' };
  const now = Date.now();
  const s = state.load();
  const last = s.boards[chatId] || 0;
  if (now - last < config.board.rateLimitMs) {
    console.log(`[看板] 群 ${chatId} 命中限流，静默跳过`);
    return { handled: true, rateLimited: true, reply: '' };
  }
  state.mutate((st) => { st.boards[chatId] = now; }); // 预占戳

  try {
    const records = await dutyTable.getRecordsByDate(todayStr());
    const card = buildBoardCard(todayStr(), records, await getYesterdaySection());
    if (config.board.webhookUrl) {
      // 主通道：群自定义机器人 webhook（非对话型）；限流仍按来源群 chatId 计
      await webhook.sendCardToWebhook(config.board.webhookUrl, config.board.webhookSecret, card);
    } else {
      console.warn('[看板] 未配置 DUTY_BOARD_WEBHOOK_URL，回退应用身份 im API 直发');
      await bot.sendCardToChat(chatId, card);
    }
    return { handled: true, rateLimited: false, reply: '' };
  } catch (err) {
    state.mutate((st) => { delete st.boards[chatId]; }); // 发卡失败回滚，下次可重试
    throw err;
  }
}

/**
 * 每日自动播报（cron 12:00，POST /api/bot/test-board 手动触发共用）：
 * 今日值日看板卡片推到值日播报群——主通道群自定义机器人 webhook（非对话型），
 * 未配置 webhook 时回退应用身份 im API 直发管辖群（与群看板回退同款，不再静默跳过）。
 * 无排班记录时跳过；dryRun 只回预览不发送。
 */
async function broadcastTodayBoard({ dryRun = false } = {}) {
  const records = await dutyTable.getRecordsByDate(todayStr());
  if (!records.length) {
    console.log('[看板播报] 今日无排班记录，跳过');
    return { skipped: true, reason: 'no_records', date: todayStr() };
  }
  const card = buildBoardCard(todayStr(), records, await getYesterdaySection());
  if (dryRun) {
    return {
      skipped: false,
      dryRun: true,
      date: todayStr(),
      members: records.map((r) => ({ name: r.name, position: r.position, status: r.status || '待定' })),
    };
  }
  if (config.board.webhookUrl) {
    try {
      await webhook.sendCardToWebhook(config.board.webhookUrl, config.board.webhookSecret, card);
      console.log(`[看板播报] 今日值日看板已推送（${records.length} 条记录）`);
      return { skipped: false, via: 'webhook', date: todayStr() };
    } catch (err) {
      console.error('[看板播报] webhook 推送失败，回退应用身份直发管辖群:', err.message);
    }
  }
  const targets = policy.getPolicy().groupChatIds;
  if (!targets.length) {
    console.warn('[看板播报] 未配置 DUTY_BOARD_WEBHOOK_URL 且无管辖群可直发，自动播报跳过');
    return { skipped: true, reason: 'webhook_not_configured_and_no_group', date: todayStr() };
  }
  for (const chatId of targets) {
    await bot.sendCardToChat(chatId, card);
  }
  console.log(`[看板播报] 未配置 webhook，已按应用身份直发 ${targets.length} 个管辖群（${records.length} 条记录）`);
  return { skipped: false, via: 'app', groups: targets.length, date: todayStr() };
}

/**
 * 私信指令路由（hub 转发：{command, openId, chatType, args?}）
 * @returns {{handled: boolean, reply: string}}
 */
async function handleCommand(payload = {}) {
  // 统一指令风格：容忍「/前缀」（/值日助手 ≙ 值日助手），与各模块 /指令 风格一致
  const raw = String(payload.command || '').trim().replace(/^\//, '');
  const openId = payload.openId || '';
  const chatType = payload.chatType === 'group' ? 'group' : 'p2p';
  const args = Array.isArray(payload.args) ? payload.args : [];

  if (!raw) return { handled: false, reply: '' };

  // 群聊只认「值日助手」看板（需 @机器人，由 hub 侧保证）；
  // 管辖校验：策略数据源在本项目（hub 侧同样以 /api/duty/policy 判定，此处防御直调）
  if (chatType === 'group') {
    if (!policy.isManagedGroup(payload.chatId)) {
      console.warn('[指令] 非值日管辖群请求看板，已拒绝:', payload.chatId);
      return { handled: true, reply: '' };
    }
    if (raw === (policy.getPolicy().hubEnforcement.groupBoardCommand || '值日助手')) {
      return handleGroupBoard(payload.chatId);
    }
    // 快递助手指令 / 取件确认（2026-09-17）：仅快递群（=值日管辖群）@ 触发
    const expressResult = await express.handleCommand(raw, { chatType: 'group', chatId: payload.chatId, openId });
    if (expressResult.handled) return expressResult;
    return { handled: false, reply: '' };
  }

  const member = roster.findByOpenId(openId);

  switch (raw) {
    case '值日助手':
      return { handled: true, reply: HELP_TEXT };

    case '是':
    case '否': {
      if (!member) {
        return { handled: true, reply: '未识别到你的账号。请先发「绑定 姓名」完成绑定，再进行值日确认。' };
      }
      return raw === '是' ? inquiry.handleYes(openId) : inquiry.handleNo(openId);
    }

    // 值日打卡主词（2026-09-13 口径）：与 DDL 确认的「是」彻底分开；效果等同「是」
    case '打卡':
    case '打卡了': {
      if (!member) {
        return { handled: true, reply: '未识别到你的账号。请先发「绑定 姓名」完成绑定，再进行值日打卡。' };
      }
      return inquiry.handleYes(openId);
    }

    // 打卡确认口语变体：仅当日有活跃询问会话时等同「是」；
    // 无会话静默交还 hub（reply 留空），避免闲聊「好/完成」被值日助手接管
    case '是的':
    case '好':
    case '好了':
    case '完成':
    case '完成了':
    case '做完了':
    case '搞定':
    case '搞定了':
      return inquiry.confirmVariant(openId);

    case '我要请假': {
      if (!member) {
        return { handled: true, reply: '未识别到你的账号。请先发「绑定 姓名」完成绑定，再请假。' };
      }
      return inquiry.requestLeave(member);
    }

    case '查询我的下一次值日': {
      if (!member) {
        return { handled: true, reply: '未识别到你的账号。请先发「绑定 姓名」完成绑定。' };
      }
      const next = await scheduleService.getNextDuty(member.name);
      if (!next) return { handled: true, reply: '📅 近期没有你的值日安排。' };
      return { handled: true, reply: `📅 你的下一次值日：${next.date}，岗位【${next.position}】\n职责：${inquiry.positionDutyText(next.position)}` };
    }

    case '生成排班表': {
      if (!roster.isAdminOpenId(openId)) {
        return { handled: true, reply: '⛔ 生成排班表仅限管理员使用。如需排班请联系管理员。' };
      }
      const result = await scheduleService.generate({ dryRun: false });
      return { handled: true, reply: scheduleService.renderGenerateReply(result) };
    }

    default:
      break;
  }

  if (raw.startsWith('绑定')) {
    const name = String(args[0] || raw.slice(2) || '').trim();
    if (!name) return { handled: true, reply: '用法：绑定 姓名（例如：绑定 张三）' };
    if (!openId) return { handled: true, reply: '未获取到你的账号标识，无法绑定。' };
    const result = roster.bindOpenId(name, openId);
    return { handled: true, reply: result.message };
  }

  // 快递助手（2026-09-17）：私聊同样可用（仅快递群指令 + 私聊触发的口径）
  const expressResult = await express.handleCommand(raw, { chatType: 'p2p', openId });
  if (expressResult.handled) return expressResult;

  return { handled: false, reply: `未识别指令「${raw}」。\n${HELP_TEXT}` };
}

/** 图片载荷入口（hub 转发：{type:'image', openId, imageKey, messageId}）
 *  p2p = 值日照片凭证；group = 快递登记窗口图片（无窗口静默忽略） */
async function handleImagePayload(payload = {}) {
  if (payload.chatType === 'group') {
    return express.handleImagePayload(payload);
  }
  try {
    return await inquiry.handleImage(payload);
  } catch (err) {
    console.error('[图片] 凭证处理失败:', err.message);
    return { handled: false, reply: `照片处理失败：${err.message}。请稍后重发或联系管理员。` };
  }
}

module.exports = {
  HELP_TEXT,
  buildBoardCard,
  handleGroupBoard,
  broadcastTodayBoard,
  handleCommand,
  handleImagePayload,
};
