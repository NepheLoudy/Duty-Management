const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function parseArrayConfig(value) {
  if (!value) return [];
  return value.split(',').map(v => v.trim()).filter(v => Boolean);
}

// ============================================================
// duty-bot（值日提醒机器人）
// 与所有 qianli 项目共用同一个飞书应用（APP_ID 相同）。
// 本项目不消费消息事件：队员私信/群指令由 gateway → hub（对话型机器人）
// 转发到 POST /api/chat/command；定时提醒/收口用应用身份经 Open API 主动发送。
// 多维表格（排班表）为单一事实来源，轮转状态每次生成时从表格记录反推。
// ============================================================

const ROOT = path.join(__dirname, '..');

// 三个值日岗位（固定取值，排班算法与表格单选项共用）
const POSITIONS = ['总负责', '工位区', '装配区'];

// 完成状态单选取值（与表格「完成状态」字段的选项一致）
const STATUS = {
  DONE: '已做完',
  LEAVE: '已请假',
  MISS: '未做完',
};

// 当日总状态唯一取值：三个附件栏各有照片且三条记录均为已做完时写入
const DAY_STATUS_DONE = '今日完成值日';

module.exports = {
  port: process.env.PORT || 3006,

  feishu: {
    appId: process.env.APP_ID || '',
    appSecret: process.env.APP_SECRET || '',
  },

  plaza: {
    // 动态广场事件流（机器人项目看板「动态广场」表，供多维表格仪表盘展示）
    appToken: process.env.PLAZA_BITABLE_APP_TOKEN || 'ZlVZbXDkRayUzSsFRiycznmZn5b',
    tableId: process.env.PLAZA_BITABLE_TABLE_ID || 'tbld1zHXkTzko20p',
  },
  bitable: {
    appToken: process.env.DUTY_BITABLE_APP_TOKEN || '',
    tableId: process.env.BITABLE_DUTY_TABLE_ID || '',
  },

  // 表字段名映射（手动建表字段名不同时只改 .env，不动代码）
  fields: {
    user: process.env.DUTY_FIELD_USER || '人员',
    name: process.env.DUTY_FIELD_NAME || '姓名',
    date: process.env.DUTY_FIELD_DATE || '日期',
    position: process.env.DUTY_FIELD_POSITION || '岗位',
    status: process.env.DUTY_FIELD_STATUS || '完成状态',
    dayStatus: process.env.DUTY_FIELD_DAY_STATUS || '当日总状态',
    receipts: {
      '总负责': process.env.DUTY_FIELD_RECEIPT_LEADER || '凭证-负责',
      '工位区': process.env.DUTY_FIELD_RECEIPT_WORKSTATION || '凭证-工位',
      '装配区': process.env.DUTY_FIELD_RECEIPT_ASSEMBLY || '凭证-装配',
    },
  },

  positions: POSITIONS,
  status: STATUS,
  dayStatusDone: DAY_STATUS_DONE,

  // 本地名册/白名单（真实文件含姓名与 open_id，永不进 git，仓库只保留 *.example.json）
  membersFile: process.env.DUTY_MEMBERS_FILE || path.join(ROOT, 'config', 'members.json'),
  whitelistFile: process.env.DUTY_WHITELIST_FILE || path.join(ROOT, 'config', 'whitelist.json'),

  // 排班生成权限：显式配置优先，否则取名册里 admin:true 的成员
  adminOpenIds: parseArrayConfig(process.env.DUTY_ADMIN_OPEN_IDS),

  schedule: {
    prevRemind: process.env.DUTY_PREV_REMIND_SCHEDULE || '0 0 20 * * *',
    // D-7 值日预告（2026-09-24 新增）：提前一周私信点名班次，留足请假余量；
    // 20:05 与次日提醒（20:00）错峰
    weekRemind: process.env.DUTY_WEEK_REMIND_SCHEDULE || '0 5 20 * * *',
    ask: process.env.DUTY_ASK_SCHEDULE || '0 30 18 * * *',
    // 收口前 1 小时临门提醒（2026-09-16 新增；2026-09-17 随收口推迟到 23:00）
    lastCall: process.env.DUTY_LASTCALL_SCHEDULE || '0 0 23 * * *',
    // 24:00（午夜）收口（2026-09-17 用户口径：大家下班晚，原 22:00 提前）。
    // 注意：0 点已跨日，cron 收口归属前一天（见 cron deadline runner 的 dateStr 处理）
    deadline: process.env.DUTY_DEADLINE_SCHEDULE || '0 0 0 * * *',
    reconcile: process.env.DUTY_RECONCILE_SCHEDULE || '0 30 0 * * *',
    // 每日自动播报今日值日看板（群自定义机器人 webhook 通道，过静默闸门）
    boardBroadcast: process.env.DUTY_BOARD_BROADCAST_SCHEDULE || '0 0 12 * * *',
  },

  generate: {
    // 每周补偿/加罚「非请假位插入」的容量上限（2026-09-25 检修新增）：超过的义务自动
    // 顺延下一周，防止欠账集中安置把一周插成天天 4 人（09-19~09-24 雪球即此因）。
    // 填入「请假空缺位」的安置不占此容量（实际干活人数不变）。
    weeklyInsertionAllowance: parseInt(process.env.DUTY_WEEKLY_INSERTION_ALLOWANCE || '2', 10),
    // 每次生成的跨度（日历月数，从最后一个已排日期的次日起）
    months: Math.max(1, parseInt(process.env.DUTY_GENERATE_MONTHS, 10) || 1),
    // 同一人两次值日的最小间隔天数（软约束，候选不足时自动放宽）
    minIntervalDays: parseInt(process.env.DUTY_MIN_INTERVAL_DAYS, 10) || 2,
  },

  board: {
    // 群内「值日助手」看板限流（毫秒，每群一次）
    rateLimitMs: (parseInt(process.env.DUTY_BOARD_RATE_LIMIT_MINUTES, 10) || 60) * 60 * 1000,
    // 今日值日看板发送通道：群自定义机器人 webhook（非对话型 im API）；
    // 留空 = 回退应用身份 im API 直发（旧行为）
    webhookUrl: process.env.DUTY_BOARD_WEBHOOK_URL || '',
    webhookSecret: process.env.DUTY_BOARD_WEBHOOK_SECRET || '',
  },

  // 值日域管辖策略（权限管辖范畴/生效范畴的单一事实来源在本项目）：
  // groupChatIds = 值日专用群（快递申领群等，逗号分隔 chat_id）；
  // 经 GET /api/duty/policy 下发给 hub 消费，hub 群内闸门以此为准。
  // 留空 = 不限制（群看板来者不拒，兼容旧部署）
  jurisdiction: {
    groupChatIds: parseArrayConfig(process.env.DUTY_GROUP_CHAT_IDS),
  },

  // 快递助手（快递申领群专属，2026-09-17）：
  // 窗口登记 → 「机器人项目看板」base 的「快递」表（用户手工建表，脚本只补缺失列）；
  // 每小时整点未取播报（过静默闸门）；群清单留空回落值日管辖群
  express: {
    enabled: process.env.EXPRESS_ENABLED !== '0',
    appToken: process.env.EXPRESS_BITABLE_APP_TOKEN || 'ZlVZbXDkRayUzSsFRiycznmZn5b',
    tableId: process.env.EXPRESS_TABLE_ID || 'tblhQuGY9ZdqDSpc',
    windowMinutes: Math.max(1, parseInt(process.env.EXPRESS_WINDOW_MINUTES, 10) || 5),
    groupChatIds: parseArrayConfig(process.env.EXPRESS_GROUP_CHAT_IDS),
    broadcastSchedule: process.env.EXPRESS_BROADCAST_SCHEDULE || '0 0 * * * *',
    fields: {
      code: process.env.EXPRESS_FIELD_CODE || '取件码',
      image: process.env.EXPRESS_FIELD_IMAGE || '快递内容',
      senderUser: process.env.EXPRESS_FIELD_SENDER || '发起人',
      regTime: process.env.EXPRESS_FIELD_REG_TIME || '登记时间',
      picked: process.env.EXPRESS_FIELD_PICKED || '是否取件',
      pickedAt: process.env.EXPRESS_FIELD_PICKED_AT || '取件时间',
      messageId: process.env.EXPRESS_FIELD_MESSAGE_ID || '消息ID',
    },
  },

  // 运行时状态（监听会话/补偿义务/看板限流时间戳/连续缺勤计数/快递窗口与编号）
  // 生产环境必须配到项目目录之外（SFTP 部署会清空 /opt/duty-bot）
  stateFile: process.env.DUTY_STATE_FILE || path.join(ROOT, '.duty-state.json'),
};
