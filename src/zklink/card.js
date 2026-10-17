// ============================================================
// 打卡时长周报卡（经典 1.0 卡片，与 duty-bot 看板卡同结构；发送走
// ../feishu/webhook.js 的 sendCardToWebhook——复用群自定义机器人分发链路）
// sessions 口径（feishu user_tasks）：有缺卡/零打卡标 orange，全勤绿色；
// pairs 口径（import/http 旧流水）：有孤条/落单/零打卡标 orange。
// ============================================================
const report = require('./report');

function buildWeeklyCard(win, agg, opts = {}) {
  const maxUserLines = opts.maxUserLines || 40;
  const mode = agg.mode || 'pairs';
  const users = agg.users || [];
  const totals = agg.totals;
  const hasIssue = mode === 'sessions'
    ? (totals.missingSessions > 0 || users.some((u) => u.punches === 0))
    : (totals.lonelyDays > 0 || totals.leftoverCards > 0 || users.some((u) => u.punches === 0));
  const userLines = report.renderUserLines(agg, { maxUserLines });
  const summary = mode === 'sessions'
    ? `**有效班次 ${totals.completeSessions} 段 · 合计时长 ${report.fmtDuration(totals.totalMs)} · 涉及 ${totals.users} 人（有打卡 ${totals.punchUsers} 人）${totals.missingSessions ? ` · 缺卡 ${totals.missingSessions} 段` : ''}**`
    : `**打卡 ${totals.punches} 条 · 合计时长 ${report.fmtDuration(totals.totalMs)} · 涉及 ${totals.users} 人（有打卡 ${totals.punchUsers} 人）${[
      totals.lonelyDays ? ` · 孤条 ${totals.lonelyDays} 天` : '',
      totals.leftoverCards ? ` · 落单 ${totals.leftoverCards} 卡` : '',
    ].join('')}**`;
  const footer = mode === 'sessions'
    ? '> 口径：按飞书考勤平台上下班配对（工作日 06:00–次日 05:59 切天，跨天班次计入起始日）；单边卡标缺卡、不计时长 · 打卡明细已留档云文档 · 数据来自飞书考勤'
    : '> 口径：当日打卡按顺序两两配对（1→2、3→4…）记「段末−段首」之和，落单卡与跨天段不计 · 打卡明细已留档云文档 · 数据来自 ZKLink 云考勤';
  const elements = [
    { tag: 'markdown', content: summary },
    { tag: 'hr' },
    { tag: 'markdown', content: totals.punches ? userLines.join('\n') : '本周无打卡记录（检查名单与 ZKLink 考勤组导出是否匹配）' },
    { tag: 'hr' },
    { tag: 'markdown', content: footer },
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
