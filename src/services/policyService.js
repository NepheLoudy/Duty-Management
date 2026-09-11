const config = require('../config');

// ============================================================
// 值日域管辖策略（权限管辖范畴与生效范畴的单一事实来源）
// hub（对话枢纽）经 GET /api/duty/policy 消费本策略，在其群内闸门代为执行：
// 哪些群归值日域管辖、群里放行什么（看板触发词/关键词回答/基础指令开关/引导语）、
// 私信直传哪些值日指令。本项目仍不消费消息事件，只下发口径。
// ============================================================

// @未命中关键词时 hub 代发的引导语（值日域对外口径归本项目定义）
const GROUP_GUIDANCE = '🧹 本群为值日/快递申领专用群：@我 发送「值日助手」查看今日值日，关键词彩蛋照常有效\n（查询排班、请假、打卡确认请私信机器人）';

function getPolicy() {
  return {
    // 管辖范畴：值日专用群 chat_id 列表（空 = 不限制，群指令来者不拒）
    groupChatIds: config.jurisdiction.groupChatIds,

    // 生效范畴：hub 在管辖群代为执行的放行规则
    hubEnforcement: {
      groupBoardCommand: '值日助手',   // 群内看板触发词（@后精确匹配）
      closeBasicCommands: true,        // hub 基础指令（/help、/print-* 等）在管辖群关闭
      keywordPassthrough: true,        // hub 关键词自动回答在管辖群放行（@与未@）
      fallbackGuidance: GROUP_GUIDANCE,
    },

    // p2p 直传指令白名单（hub 值日分支放行依据，绕过 hub 私聊指令白名单）
    p2pCommands: ['值日助手', '我要请假', '查询我的下一次值日', '是', '否', '生成排班表'],
    p2pCommandPrefixes: ['绑定'],
  };
}

// 管辖判定（本项目对转发载荷的防御性校验用；空列表 = 不限制）
function isManagedGroup(chatId) {
  const ids = config.jurisdiction.groupChatIds;
  return ids.length === 0 || ids.includes(chatId);
}

module.exports = { getPolicy, isManagedGroup, GROUP_GUIDANCE };
