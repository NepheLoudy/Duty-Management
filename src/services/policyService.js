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
  const override = readOverride();
  return {
    // 管辖范畴：值日专用群 chat_id 列表（空 = 不限制，群指令来者不拒）；
    // 在线改写（POST /api/duty/policy）落在 override 文件，优先于 env
    groupChatIds: override.groupChatIds || config.jurisdiction.groupChatIds,
    overrideActive: Boolean(override.groupChatIds),

    // 生效范畴：hub 在管辖群代为执行的放行规则
    hubEnforcement: {
      groupBoardCommand: '值日助手',   // 群内看板触发词（@后精确匹配，容忍 / 前缀）
      closeBasicCommands: true,        // hub 基础指令（/help、/print-* 等）在管辖群关闭
      keywordPassthrough: true,        // hub 关键词自动回答在管辖群放行（@与未@）
      fallbackGuidance: GROUP_GUIDANCE,
    },

    // p2p 直传指令白名单（hub 值日分支放行依据，绕过 hub 私聊指令白名单）；
    // / 前缀变体与裸词等效（duty-bot 侧统一去前缀）
    p2pCommands: [
      '值日助手', '我要请假', '查询我的下一次值日', '是', '否', '生成排班表',
      '/值日助手', '/我要请假', '/查询我的下一次值日', '/是', '/否', '/生成排班表',
    ],
    p2pCommandPrefixes: ['绑定', '/绑定'],
  };
}

// 在线改写存储（管辖范畴热更新；不留则回落 env）
function readOverride() {
  const fs = require('fs');
  const path = require('path');
  try {
    const file = path.join(__dirname, '..', '..', 'config', 'policy-override.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function saveOverride(patch) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', '..', 'config', 'policy-override.json');
  const merged = { ...readOverride(), ...patch };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return merged;
}

// 管辖判定（本项目对转发载荷的防御性校验用；空列表 = 不限制）
function isManagedGroup(chatId) {
  const ids = getPolicy().groupChatIds;
  return ids.length === 0 || ids.includes(chatId);
}

module.exports = { getPolicy, isManagedGroup, saveOverride, GROUP_GUIDANCE };
