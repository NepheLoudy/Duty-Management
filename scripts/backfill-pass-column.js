#!/usr/bin/env node
// ============================================================
// 历史周「是否及格」补勾（2026-11-09 v71 一次性工具）
// 逐周走播报链同一取数口径（collectWeekly 逻辑内联：通讯录补齐+考勤组名单+平台班段聚合）
// → archiveToDoc（objType=bitable 自动分派 archiveToBitable）重算写表。
// 只写表格：不发 webhook、不碰 store 水位、不写云文档块（bitable 分派天然不进 docx 分支）。
// 附带效果：历史周「该周时长」刷新为平台当前真值（补卡/改卡后的最新数据）。
//
// 用法（部署目标跑）：
//   node scripts/backfill-pass-column.js                 # dryRun：只打印每周判定摘要，不写表
//   node scripts/backfill-pass-column.js --confirm       # 实写
//   node scripts/backfill-pass-column.js --confirm --from=0 --to=8   # 默认 offset 0~8（week9~week1）
// ============================================================
const config = require('../src/zklink/config');
const report = require('../src/zklink/report');
const store = require('../src/zklink/store');
const importService = require('../src/zklink/importService');
const feishuAttendance = require('../src/zklink/feishuAttendance');
const feishuDoc = require('../src/zklink/feishuDoc');
const passRule = require('../src/zklink/passRule');

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const from = Number((args.find((a) => a.startsWith('--from=')) || '').split('=')[1] ?? 0) || 0;
const to = Number((args.find((a) => a.startsWith('--to=')) || '').split('=')[1] ?? 8);
const sendDow = config.cronParts.dow == null ? 1 : config.cronParts.dow;

(async () => {
  if (!passRule.passEnabled()) {
    console.error('及格判定未启用（缺 ZKLINK_PASS_HOURS_* 或花名册定位键）——先补 .env 再跑');
    process.exit(1);
  }
  const gm = await passRule.loadGradeMap({ refresh: true });
  console.log('花名册 ' + gm.count + ' 人（核心 ' + config.passRules.core + 'h / 正式 ' + config.passRules.formal + 'h / 梯队 ' + config.passRules.echelon + 'h）| 模式=' + (confirm ? '实写' : 'dryRun') + ' | 周范围 offset ' + from + '~' + to);
  for (let off = from; off <= to; off++) {
    const win = report.weekWindow(off, Date.now(), sendDow);
    try {
      // —— 取数（与 collectWeekly 的 feishu 档同口径）——
      let members = store.loadMembers();
      let extraMembers = [];
      try {
        const users = await feishuAttendance.listUsersWithUserId();
        const whitelist = new Set(config.loadAttendanceWhitelist());
        extraMembers = users.filter((u) => !whitelist.has(u.name));
        members = importService.mergeMembers(members, extraMembers);
      } catch (e) {
        console.warn('  [weekOffset=' + off + '] 通讯录补齐失败（' + e.message + '），按已有名单继续');
      }
      const r = await feishuAttendance.fetchTaskSessions(win.start, win.end, { extraMembers });
      try {
        const g = await feishuAttendance.resolveGroupMembers();
        if (g.members && g.members.length) members = importService.mergeMembers(members, g.members);
      } catch (e) { /* 考勤组取不到不阻塞 */ }
      const agg = report.aggregateSessions(r.sessions, members);
      // —— 判定摘要 ——
      const graded = [];
      const ungraded = [];
      for (const u of agg.users) {
        const j = passRule.judgePass({ name: u.name, openId: u.openId, totalMs: u.totalMs }, gm);
        if (j) graded.push({ name: u.name, grade: j.grade, pass: j.pass, hours: Math.round(u.totalMs / 360000) / 10 });
        else ungraded.push(u.name);
      }
      const t = graded.filter((x) => x.pass).length;
      const f = graded.length - t;
      console.log('  [' + win.label + '] 判定 ' + graded.length + ' 人（达标 ' + t + ' / 未达标 ' + f + '）未入花名册 ' + ungraded.length + ' 人留空' + (ungraded.length ? '：' + ungraded.join('、') : ''));
      if (!confirm) continue;
      const res = await feishuDoc.archiveToDoc(win, agg, agg.rawRecords, { dataSource: 'feishu' });
      console.log('    实写完成：新建 ' + res.appended + ' 行 / 更新 ' + (res.updated || 0) + ' 行');
    } catch (e) {
      console.warn('  [' + win.label + '] 该周处理失败（' + e.message + '）——跳过继续');
    }
  }
  console.log('补勾结束（' + (confirm ? '已实写' : 'dryRun 预览——加 --confirm 实写') + '）');
  process.exit(0);
})().catch((e) => { console.error('补勾失败:', e.message); process.exit(1); });
