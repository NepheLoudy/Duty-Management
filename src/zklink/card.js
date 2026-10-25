// ============================================================
// 打卡时长周报卡（经典 1.0 卡片，与 duty-bot 看板卡同结构；发送走
// ../feishu/webhook.js 的 sendCardToWebhook——复用群自定义机器人分发链路）
// v63（2026-10-26 曼波定）：改为短卡——只发合计 + 留档文档链接，不再往群里
// 刷逐人名单（长名单影响队员工作）；明细以周为单位在留档「打卡记录」里看。
// sessions 口径（feishu user_tasks）：有缺卡/零打卡标 orange；pairs 口径（旧流水）：有孤条/落单/零打卡标 orange。
// ============================================================
const report = require('./report');

function buildWeeklyCard(win, agg, opts = {}) {
  const mode = agg.mode || 'pairs';
  const users = agg.users || [];
  const totals = agg.totals;
  const hasIssue = mode === 'sessions'
    ? (totals.missingSessions > 0 || users.some((u) => u.punches === 0))
    : (totals.lonelyDays > 0 || totals.leftoverCards > 0 || users.some((u) => u.punches === 0));
  const summary = mode === 'sessions'
    ? `**有效班次 ${totals.completeSessions} 段 · 合计时长 ${report.fmtDuration(totals.totalMs)} · 涉及 ${totals.users} 人（有打卡 ${totals.punchUsers} 人）${totals.missingSessions ? ` · 缺卡 ${totals.missingSessions} 段` : ''}**`
    : `**打卡 ${totals.punches} 条 · 合计时长 ${report.fmtDuration(totals.totalMs)} · 涉及 ${totals.users} 人（有打卡 ${totals.punchUsers} 人）${[
      totals.lonelyDays ? ` · 孤条 ${totals.lonelyDays} 天` : '',
      totals.leftoverCards ? ` · 落单 ${totals.leftoverCards} 卡` : '',
    ].join('')}**`;
  const linkLine = opts.archiveLink
    ? `📎 **本周明细与历史各周留档**：[打卡记录（按周）](${opts.archiveLink})`
    : '📎 留档链接未配置（ZKLINK_ARCHIVE_DOC_TOKEN）';
  const footer = mode === 'sessions'
    ? '> 口径：飞书考勤平台上下班配对（工作日 06:00–次日 05:59 切天，跨天班次计入起始日）；单边卡标缺卡、不计时长 · 明细以周为单位留档于上方文档'
    : '> 口径：当日打卡按顺序两两配对（1→2、3→4…）记「段末−段首」之和，落单卡与跨天段不计 · 打卡明细已留档云文档 · 数据来自 ZKLink 云考勤';
  const empty = totals.punches ? null : '本周无打卡记录（检查名单与 ZKLink 考勤组导出是否匹配）';
  const elements = [
    { tag: 'markdown', content: empty || summary },
    { tag: 'hr' },
    { tag: 'markdown', content: linkLine },
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
