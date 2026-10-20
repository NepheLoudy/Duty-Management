// ============================================================
// 可选插件：梯队评价表「考勤时长」回填（2026-10-20 曼波定）
//
// 插拔边界：
//   - 只依赖 zklink 的「平台打卡班段」数据层（fetchTaskSessions + aggregateSessions），
//     不改核心排班/周报逻辑；关掉 ROSTER_FILL_ENABLED=0 即停 cron，
//     删掉 src/plugins/rosterFill 目录 + src/index.js 的一行启动调用即完全移除。
//   - 只写目标表的「考勤时长」数字列（小时，1 位小数），不动请假/效率减免/
//     时长警示/合格公式等其它列。
// ============================================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

module.exports = {
  enabled: process.env.ROSTER_FILL_ENABLED === '1',
  // 目标 bitable：wiki 节点解析出的 base app_token + 数据表 id
  appToken: process.env.ROSTER_FILL_APP_TOKEN || '',
  tableId: process.env.ROSTER_FILL_TABLE_ID || '',
  fields: {
    member: process.env.ROSTER_FILL_FIELD_MEMBER || '梯队队员',
    duration: process.env.ROSTER_FILL_FIELD_DURATION || '考勤时长',
    period: process.env.ROSTER_FILL_FIELD_PERIOD || '时段',
  },
  // 第一组对应的周一（YYYY-MM-DD）；组序号 = (目标周一 - 首组周一) / 7 天
  firstWeekStart: process.env.ROSTER_FILL_FIRST_WEEK_START || '',
  // 每周一 09:40 上海（值日打卡周报 09:30 之后），填「上一周」
  cron: process.env.ROSTER_FILL_CRON || '40 9 * * 1',
  overwrite: process.env.ROSTER_FILL_OVERWRITE !== '0',
  timezone: 'Asia/Shanghai',
};
