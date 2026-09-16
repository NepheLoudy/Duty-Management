const config = require('../config');

// ============================================================
// 值日域管辖策略（权限管辖范畴与生效范畴的单一事实来源）
// hub（对话枢纽）经 GET /api/duty/policy 消费本策略，在其群内闸门代为执行：
// 哪些群归值日域管辖、群里放行什么（看板触发词/关键词回答/基础指令开关/引导语）、
// 私信直传哪些值日指令。本项目仍不消费消息事件，只下发口径。
// ============================================================

// @未命中关键词时 hub 代发的引导语（值日域对外口径归本项目定义）。
// 文案原则：只写「应该怎么做」，不通告能力范围（彩蛋是否有效之类的说明不上引导语）
const GROUP_GUIDANCE = '🧹 @我 发送「值日助手」查看今日值日\n查询排班、请假、打卡确认请私信机器人';

function getPolicy() {
  const override = readOverride();
  return {
    // 管辖范畴：值日专用群 chat_id 列表（空 = 不限制，群指令来者不拒）；
    // 在线改写（POST /api/duty/policy）落在 override 文件，优先于 env
    groupChatIds: override.groupChatIds || config.jurisdiction.groupChatIds,
    overrideActive: Boolean(override.groupChatIds),

    // 生效范畴：hub 在管辖群代为执行的放行规则
    hubEnforcement: {
      groupBoardCommand: '值日助手',   // 群内看板触发词（hub 群门按 裸词/带/ 双形态匹配；本仓 p2p 侧去前缀双保险）
      closeBasicCommands: true,        // hub 基础指令（/help、/print-* 等）在管辖群关闭
      fallbackGuidance: GROUP_GUIDANCE,
    },

    // p2p 直传指令白名单（hub 值日分支放行依据，绕过 hub 私聊指令白名单）；
    // / 前缀变体与裸词等效（duty-bot 侧统一去前缀）；
    // 打卡确认口语变体：hub 放行后由 duty-bot 判定——有当日活跃询问会话才生效；
    // 快递助手指令（2026-09-17）：群内经 groupCommands 放行，私聊经本清单放行
    p2pCommands: [
      '值日助手', '我要请假', '查询我的下一次值日', '是', '否', '打卡', '打卡了', '生成排班表',
      '是的', '好', '好了', '完成', '完成了', '做完了', '搞定', '搞定了',
      '快递助手', '快递', '查询当前快递', '已取', '全部已取',
      '/值日助手', '/我要请假', '/查询我的下一次值日', '/是', '/否', '/打卡', '/打卡了', '/生成排班表',
      '/快递助手', '/快递', '/查询当前快递',
    ],
    p2pCommandPrefixes: ['绑定', '/绑定'],
    // 取件回复词形（已取n / 全部已取）：p2p 与群 @ 转发放行依据（正则，hub 消费）
    p2pCommandPatterns: ['^已取\\s*\\d*$', '^全部已取$'],

    // 管辖群内 hub 转发的指令子集（2026-09-17 拆分：groupCommands 只含真指令，
    // 不含 p2pCommands 里的确认口语词——修复非管辖群 @「好/完成」被值日引导语误拦）
    groupCommands: ['值日助手', '快递助手', '快递', '查询当前快递'],

    // 快递助手开关（hub 据此决定是否对管辖群做非@观察转发）
    express: { enabled: config.express.enabled },
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
