const { requestAPI } = require('./client');

// ============================================================
// 消息发送层（应用身份 IM API）
// - 定时提醒/询问/收口回执：私信（sendTextToUser）
// - 群看板（值日助手）：主通道为群自定义机器人 webhook（feishu/webhook.js），
//   未配置 DUTY_BOARD_WEBHOOK_URL 时回退本层 sendCardToChat
// 「昨日值日播报」已并入本项目看板卡的「昨日战报」段（12:00 与手动看板同卡，
// 原pm-robot 渲染方案作废）。
// ============================================================

// 230013 = 机器人对该用户不可用：飞书「应用可用范围」不含对方，属平台 ACL，API 无法绕过
function availabilityHint(code) {
  return code === 230013
    ? ' —— 对方不在应用可用范围内，需管理员在飞书开发者后台把「可用范围」改为全员（或加入对方）'
    : '';
}

async function sendTextToUser(openId, text) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=open_id',
    {
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }
  );
  if (res.code !== 0) {
    throw new Error(`发送私聊消息失败: ${res.msg} (code: ${res.code})${availabilityHint(res.code)}`);
  }
  return res.data;
}

async function sendTextToChat(chatId, text) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }
  );
  if (res.code !== 0) {
    throw new Error(`发送群消息失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

/** 群卡片直发（应用身份）——看板通道的回退路径（主通道为群自定义机器人 webhook） */
async function sendCardToChat(chatId, cardContent) {
  const res = await requestAPI(
    'POST',
    '/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(cardContent),
    }
  );
  if (res.code !== 0) {
    throw new Error(`发送群卡片消息失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

module.exports = {
  sendTextToUser,
  sendTextToChat,
  sendCardToChat,
};
