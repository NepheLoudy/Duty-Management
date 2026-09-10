const config = require('../config');
const { todayStr } = require('../utils/dates');
const bot = require('../feishu/bot');
const roster = require('./rosterService');
const state = require('./stateStore');
const dutyTable = require('./dutyTableService');
const scheduleService = require('./scheduleService');
const inquiry = require('./inquiryService');

// ============================================================
// 值日助手（经 hub 转发的被动指令层，POST /api/chat/command）
// - 私信（精确匹配）：值日助手 / 我要请假 / 查询我的下一次值日 / 绑定 X /
//   是 / 否 / 生成排班表（仅名册 admin）
// - 群聊（@机器人 值日助手）：今日值日状态看板卡片，每群 1 小时限流一次，
//   命中限流静默
// - 图片载荷：{type:'image', openId, imageKey, messageId}
// ============================================================

const HELP_TEXT = [
  '🧹 值日助手用法：',
  '· 「查询我的下一次值日」—— 下次值日日期与岗位',
  '· 「我要请假」—— 登记请假（当次置已请假，下周自动补插一次值日）',
  '· 「绑定 姓名」—— 首次使用绑定账号（提醒与确认走私信）',
  '· 「是」/「否」—— 值日日 18:30 询问后的完成确认（照片可直接发我，22:00 收口）',
  '· 「生成排班表」—— 管理员专用，按日历向下生成一个月排班',
  '',
  '规则：完成后回复「是」并上传现场照片（照片写入值日表对应岗位栏）；22:00 收口，未回复「是」记为未做完。',
].join('\n');

/** 今日值日状态看板卡片 */
function buildBoardCard(dateStr, records) {
  const dayStatus = dutyTable.computeDayStatus(records)
    || records.map((r) => r.dayStatus).find(Boolean)
    || null;

  const lines = ['总负责', '工位区', '装配区'].map((pos) => {
    const rec = records.find((r) => r.position === pos);
    if (!rec) return `· ${pos}：（暂无排班）`;
    const statusText = rec.status || '待定';
    const photoText = (rec.receiptCounts[pos] || 0) > 0 ? ` 📎${rec.receiptCounts[pos]}` : '';
    const unbound = rec.name ? '' : '（未绑定）';
    return `· ${pos}：${rec.name || '（未绑定）'} —— ${statusText}${photoText}${unbound}`;
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: dayStatus ? 'green' : (records.length ? 'orange' : 'grey'),
      title: { content: '🧹 今日值日看板', tag: 'plain_text' },
    },
    elements: [
      { tag: 'markdown', content: `**📅 ${dateStr}**　总状态：${dayStatus || '未完成/待定'}` },
      { tag: 'hr' },
      { tag: 'markdown', content: lines.join('\n') },
      { tag: 'hr' },
      { tag: 'markdown', content: '> 私信我「值日助手」可查询排班、请假；完成后回复「是」并上传照片，22:00 收口。' },
    ],
  };
}

/** 群看板（每群 1 小时限流，命中静默） */
async function handleGroupBoard(chatId) {
  if (!chatId) return { handled: false, reply: '' };
  const now = Date.now();
  const s = state.load();
  const last = s.boards[chatId] || 0;
  if (now - last < config.board.rateLimitMs) {
    console.log(`[看板] 群 ${chatId} 命中限流，静默跳过`);
    return { handled: true, rateLimited: true, reply: '' };
  }

  const records = await dutyTable.getRecordsByDate(todayStr());
  await bot.sendCardToChat(chatId, buildBoardCard(todayStr(), records));
  state.mutate((st) => { st.boards[chatId] = now; });
  return { handled: true, rateLimited: false, reply: '' };
}

/**
 * 私信指令路由（hub 转发：{command, openId, chatType, args?}）
 * @returns {{handled: boolean, reply: string}}
 */
async function handleCommand(payload = {}) {
  const raw = String(payload.command || '').trim();
  const openId = payload.openId || '';
  const chatType = payload.chatType === 'group' ? 'group' : 'p2p';
  const args = Array.isArray(payload.args) ? payload.args : [];

  if (!raw) return { handled: false, reply: '' };

  // 群聊只认「值日助手」看板（需 @机器人，由 hub 侧保证）
  if (chatType === 'group') {
    if (raw === '值日助手') return handleGroupBoard(payload.chatId);
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

  return { handled: false, reply: `未识别指令「${raw}」。\n${HELP_TEXT}` };
}

/** 图片载荷入口（hub 转发：{type:'image', openId, imageKey, messageId}） */
async function handleImagePayload(payload = {}) {
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
  handleCommand,
  handleImagePayload,
};
