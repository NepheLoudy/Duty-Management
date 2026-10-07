// ============================================================
// 打卡时长周报卡（经典 1.0 卡片，与 duty-bot 看板卡同结构；发送走
// ../feishu/webhook.js 的 sendCardToWebhook——复用群自定义机器人分发链路）
// 有孤条/缺勤标 orange 提醒，全勤绿色。
// ============================================================
const report = require('./report');

function buildWeeklyCard(win, agg, opts = {}) {
  const maxUserLines = opts.maxUserLines || 40;
  const users = agg.users || [];
  const hasIssue = agg.totals.lonelyDays > 0 || users.some((u) => u.punches === 0);
  const userLines = report.renderUserLines(agg, { maxUserLines });
  const elements = [
    { tag: 'markdown', content: `**打卡 ${agg.totals.punches} 条 · 合计时长 ${report.fmtDuration(agg.totals.totalMs)} · 涉及 ${agg.totals.users} 人（有打卡 ${agg.totals.punchUsers} 人）${agg.totals.lonelyDays ? ` · 孤条 ${agg.totals.lonelyDays} 天` : ''}**` },
    { tag: 'hr' },
    { tag: 'markdown', content: agg.totals.punches ? userLines.join('\n') : '本周无打卡记录（检查名单与 ZKLink 考勤组导出是否匹配）' },
    { tag: 'hr' },
    { tag: 'markdown', content: `> 口径：单日 ≥2 条记「末卡−首卡」，1 条=孤条不计时长 · 打卡明细已留档云文档 · 数据来自 ZKLink 云考勤` },
  ];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: hasIssue ? 'orange' : 'green',
      title: { content: `⏱ 打卡时长周报（${win.label}）`, tag: 'plain_text' },
    },
    elements,
  };
}

module.exports = { buildWeeklyCard };
