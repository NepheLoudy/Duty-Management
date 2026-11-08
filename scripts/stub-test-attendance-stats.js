// 打卡时长统计载荷桩测试（2026-11-09 v70）：currentWeekWindow / collectWeekly 抽取复用 /
// buildStatsPayload 载荷形状（totals + 逐人逐日 + 逐班段）+ ongoing 不算缺卡 + pairs 档降级。
// 名单源与 fetchTaskSessions 全打桩（不出网）；日期全部相对「今天」动态生成（防日期敏感翻车）。
// 运行：npm run test:attendance-stats（接入 push.js 部署闸门）
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---- 环境隔离（必须在 require 任何 src 模块前设置） ----
process.env.ZKLINK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-zk-stats-'));
process.env.APP_ID = 'test-app';
process.env.APP_SECRET = 'test-secret';

const report = require('../src/zklink/report');
const config = require('../src/zklink/config');
const store = require('../src/zklink/store');
const feishuAttendance = require('../src/zklink/feishuAttendance');
const service = require('../src/zklink/service');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.error('  ✗ ' + name + ' — ' + extra); }
}

const sec = (s) => Math.floor(Date.parse(s) / 1000);
const min = (n) => n * 60000;
const DAY_MS = 24 * 3600 * 1000;
const OFFSET = report.SHANGHAI_OFFSET_MS;

(async () => {
  // ---- 名单源与班段抓取打桩（service 经模块属性调用，改属性即生效） ----
  config.loadAttendanceWhitelist = () => [];
  feishuAttendance.listUsersWithUserId = async () => [
    { userid: 'u-zhang', name: '张三' },
    { userid: 'u-wang', name: '王五' },
  ];
  feishuAttendance.resolveGroupMembers = async () => ({
    members: [
      { userid: 'u-zhang', name: '张三' },
      { userid: 'u-wang', name: '王五' },
      { userid: 'u-li', name: '李四' },
    ],
    group: { groupName: '测试考勤组' },
  });

  // 班段日期全部相对锚点动态生成：
  //   today（任何星期都在本周窗口内）：张三完整 547min + 张三进行中 + 李四完整 60min
  //   d1/d2 = weekOffset=1 窗口的周一/周二（保证落在该窗口内）
  const today = report.fmtDay(Date.now() + OFFSET);
  const w1 = report.weekWindow(1, Date.now(), 1);
  const d1 = report.fmtDay(w1.startWall);
  const d2 = report.fmtDay(w1.startWall + DAY_MS);
  const at = (day, hm) => sec(day + 'T' + hm + ':00+08:00');
  const mk = (userid, name, day, inHm, outHm) => ({
    userid: userid,
    _name: name,
    day: day,
    checkin_time: inHm ? at(day, inHm) : null,
    checkout_time: outHm ? at(day, outHm) : null,
    durationMs: (inHm && outHm) ? Math.max(0, at(day, outHm) - at(day, inHm)) * 1000 : 0,
    complete: !!(inHm && outHm),
    missing: !(inHm && outHm),
    cross_day: false,
  });
  const ALL = [
    mk('u-zhang', '张三', today, '08:55', '18:02'),
    mk('u-zhang', '张三', today, '20:00', null),
    mk('u-li', '李四', today, '10:00', '11:00'),
    mk('u-zhang', '张三', d1, '09:00', '18:00'),
    mk('u-zhang', '张三', d2, '09:00', null),
  ];

  feishuAttendance.fetchTaskSessions = async (startMs, endMs) => {
    const from = report.fmtDay(startMs + OFFSET);
    const to = report.fmtDay(endMs - 1 + OFFSET);
    return {
      sessions: ALL.filter((s) => s.day >= from && s.day <= to),
      userCount: 3,
      invalidUserIds: [],
      unauthorizedUserIds: [],
    };
  };

  console.log('\n== 1. range=current：进行中窗口 + ongoing 不算缺卡 ==');
  config.dataSource = 'feishu';
  const cur = await service.buildStatsPayload({ range: 'current' });
  check('窗口 label 带（进行中）', cur.window.label.indexOf('（进行中）') !== -1, cur.window.label);
  check('窗口 key=current- 前缀', String(cur.window.key).indexOf('current-') === 0, cur.window.key);
  check('mode/dataSource/range/weekOffset 透传', cur.mode === 'sessions' && cur.dataSource === 'feishu' && cur.range === 'current' && cur.weekOffset === null, JSON.stringify({ mode: cur.mode, ds: cur.dataSource, range: cur.range, off: cur.weekOffset }));
  check('名单合并 3 人（通讯录+考勤组）', cur.memberCount === 3, String(cur.memberCount));
  const cz = cur.users.find((u) => u.userid === 'u-zhang');
  const cl = cur.users.find((u) => u.userid === 'u-li');
  const cw = cur.users.find((u) => u.userid === 'u-wang');
  check('张三：1 完整段，进行中段不计缺卡', cz.completeSessions === 1 && cz.missingSessions === 0 && cz.ongoingSessions === 1, JSON.stringify(cz));
  check('张三 时长=9h7m（547 分钟）', cz.totalMs === min(547), String(cz.totalMs));
  check('张三 sessionDetails：进行中段 missing=false/ongoing=true/outClock=null', (() => {
    const s = cz.sessionDetails.find((x) => x.ongoing);
    return !!s && s.missing === false && s.outClock === null && s.inClock === '20:00' && s.complete === false;
  })(), JSON.stringify(cz.sessionDetails));
  check('张三 days：今天 ongoing=true 且不计缺卡', (() => {
    const d = cz.days.find((x) => x.day === today);
    return !!d && d.ongoing === true && d.missingSessions === 0 && d.durationMin === 547;
  })(), JSON.stringify(cz.days));
  check('李四：1 完整段 1h、无进行中', cl.completeSessions === 1 && cl.totalMs === min(60) && cl.ongoingSessions === 0, JSON.stringify(cl));
  check('王五：名单内零记录 0 天 0 时长也列出', cw.punchDays === 0 && cw.totalMs === 0 && cw.sessionDetails.length === 0, JSON.stringify(cw));
  check('totals：进行中 1 段、缺卡 0 段（已扣 ongoing）', cur.totals.ongoingSessions === 1 && cur.totals.missingSessions === 0, JSON.stringify(cur.totals));
  check('generatedAt 存在', typeof cur.generatedAt === 'string' && cur.generatedAt.length > 0);

  console.log('\n== 2. range=week（weekOffset=1）：整周口径 + 真缺卡保留 ==');
  const wk = await service.buildStatsPayload({ offset: 1 });
  check('窗口 label 为完整周格式', /^\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}$/.test(wk.window.label), wk.window.label);
  check('range/weekOffset 口径', wk.range === 'week' && wk.weekOffset === 1);
  const wz = wk.users.find((u) => u.userid === 'u-zhang');
  check('张三：1 完整段 + 1 真缺卡（非今天不算 ongoing）', wz.completeSessions === 1 && wz.missingSessions === 1 && wz.ongoingSessions === 0, JSON.stringify(wz));
  check('张三 缺卡段明细 missing=true/ongoing=false', (() => {
    const s = wz.sessionDetails.find((x) => x.day === d2);
    return !!s && s.missing === true && s.ongoing === false && s.outClock === null && s.inClock === '09:00';
  })(), JSON.stringify(wz.sessionDetails));
  check('张三 该周时长=9h（540 分钟）', wz.totalMs === min(540), String(wz.totalMs));
  check('totals：缺卡 1 段、进行中 0 段', wk.totals.missingSessions === 1 && wk.totals.ongoingSessions === 0, JSON.stringify(wk.totals));
  check('窗口外班段被过滤：李四 0 天、王五 0 天', (() => {
    const l = wk.users.find((u) => u.userid === 'u-li');
    const w = wk.users.find((u) => u.userid === 'u-wang');
    return l.punchDays === 0 && w.punchDays === 0;
  })(), JSON.stringify(wk.users.map((u) => [u.userid, u.punchDays])));

  console.log('\n== 3. import 档（pairs 模式）：sessionDetails 恒空 + 逐日合计降级 ==');
  config.dataSource = 'import';
  store.mergeSaveState({
    imported: {
      records: [
        { userid: 'u-zhang', _name: '张三', checkin_time: at(d1, '09:00') },
        { userid: 'u-zhang', _name: '张三', checkin_time: at(d1, '10:00') },
      ],
      importedAt: new Date().toISOString(),
      days: d1 + ' ~ ' + d2,
      count: 2,
    },
  });
  // 用 weekOffset=1 的固定窗口（d1 必在其中），不依赖运行时刻——「本周至今」窗口在周一清早
  // 只开了几分钟，写死当日钟点会落进未来被窗口过滤（实测翻车一次的教训）
  const imp = await service.buildStatsPayload({ offset: 1 });
  check('mode=pairs 透传', imp.mode === 'pairs' && imp.totals.mode === 'pairs', JSON.stringify({ mode: imp.mode }));
  check('sessionDetails 恒空（pairs 无班段概念）', imp.users.every((u) => Array.isArray(u.sessionDetails) && u.sessionDetails.length === 0));
  check('张三 逐日合计 1h（09:00→10:00 配对）', (() => {
    const u = imp.users.find((x) => x.userid === 'u-zhang');
    return u && u.days.length === 1 && u.days[0].durationMin === 60 && u.totalMs === min(60);
  })(), JSON.stringify(imp.users));
  check('ongoingSessions 恒 0（pairs 不判进行中）', imp.totals.ongoingSessions === 0 && imp.users.every((u) => u.ongoingSessions === 0));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
})().catch((e) => { console.error('测试执行失败:', e); process.exit(1); });
