// 打卡结果（user_tasks）口径桩测试：平台上下班配对 / 06:00 切天 / 多班段 / 缺卡（mock fetch，不出网）
// 运行：npm run test:zklink-sessions（接入 push.js 部署闸门）
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---- 环境隔离（必须在 require 任何 src 模块前设置） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-zk-sessions-'));
process.env.ZKLINK_DATA_DIR = TMP;
process.env.APP_ID = 'test-app';
process.env.APP_SECRET = 'test-secret';

const report = require('../src/zklink/report');
const card = require('../src/zklink/card');
const feishuDoc = require('../src/zklink/feishuDoc');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}

const sec = (s) => Math.floor(Date.parse(s) / 1000);
const min = (n) => n * 60000;

(async () => {
  console.log('\n== 1. aggregateSessions：平台班段累加 / 跨天 / 多段 / 缺卡 ==');
  const sessions = [
    // 张三 10-12 两段：白天 9h7m + 跨午夜 5h
    { userid: 'zhangsan', _name: '张三', day: '2026-10-12', checkin_time: sec('2026-10-12T08:55:00+08:00'), checkout_time: sec('2026-10-12T18:02:00+08:00'), durationMs: min(547), complete: true, missing: false },
    { userid: 'zhangsan', _name: '张三', day: '2026-10-12', checkin_time: sec('2026-10-12T20:00:00+08:00'), checkout_time: sec('2026-10-13T01:00:00+08:00'), durationMs: min(300), complete: true, missing: false, cross_day: true },
    // 张三 10-13 只有上班卡 → 缺卡
    { userid: 'zhangsan', _name: '张三', day: '2026-10-13', checkin_time: sec('2026-10-13T09:00:00+08:00'), checkout_time: null, durationMs: 0, complete: false, missing: true },
    // 李四 10-12 单边卡但平台 NoNeedCheck → 不算缺卡
    { userid: 'lisi', _name: '李四', day: '2026-10-12', checkin_time: sec('2026-10-12T09:00:00+08:00'), checkout_time: null, durationMs: 0, complete: false, missing: false },
    // 李四 10-13 一段 2h
    { userid: 'lisi', _name: '李四', day: '2026-10-13', checkin_time: sec('2026-10-13T10:00:00+08:00'), checkout_time: sec('2026-10-13T12:00:00+08:00'), durationMs: min(120), complete: true, missing: false },
  ];
  const members = [
    { userid: 'zhangsan', name: '张三' },
    { userid: 'lisi', name: '李四' },
    { userid: 'wangwu', name: '王五' },
  ];
  const agg = report.aggregateSessions(sessions, members);
  const zs = agg.users.find((u) => u.userid === 'zhangsan');
  const ls = agg.users.find((u) => u.userid === 'lisi');
  const ww = agg.users.find((u) => u.userid === 'wangwu');

  check('模式=sessions', agg.mode === 'sessions' && agg.totals.mode === 'sessions');
  check('张三 2 天 / 5 卡 / 2 有效段 / 1 缺卡', zs.punchDays === 2 && zs.punches === 5 && zs.completeSessions === 2 && zs.missingSessions === 1, JSON.stringify(zs));
  check('张三 时长=9h7m+5h=14h7m', zs.totalMs === min(547 + 300), String(zs.totalMs));
  check('张三 同一天多段合并：10-12 两段 847 分钟', zs.days[0].day === '2026-10-12' && zs.days[0].durationMs === min(847) && zs.days[0].count === 4, JSON.stringify(zs.days[0]));
  check('张三 10-13 单边卡标记缺卡', zs.days[1].missingSessions === 1 && zs.days[1].durationMs === 0, JSON.stringify(zs.days[1]));
  check('李四 NoNeedCheck 单边卡不算缺卡', ls.missingSessions === 0 && ls.punches === 3 && ls.completeSessions === 1, JSON.stringify(ls));
  check('李四 时长=2h', ls.totalMs === min(120), String(ls.totalMs));
  check('王五 名单内零记录 → 0 天 0 时长', ww.punchDays === 0 && ww.punches === 0 && ww.totalMs === 0, JSON.stringify(ww));
  check('totals：3 有效段 / 1 缺卡 / 3 人 / 2 人有打卡', agg.totals.completeSessions === 3 && agg.totals.missingSessions === 1 && agg.totals.users === 3 && agg.totals.punchUsers === 2, JSON.stringify(agg.totals));
  check('totals 总时长=(847+120) 分钟', agg.totals.totalMs === min(967), String(agg.totals.totalMs));

  console.log('\n== 2. 文案/CSV/卡片/云文档按 sessions 口径分支 ==');
  const lines = report.renderUserLines(agg);
  const lsLine = lines.find((l) => l.includes('李四')) || '';
  check('人员行含缺卡计数', lines.some((l) => l.includes('张三') && l.includes('缺卡 1 段')) && !lsLine.includes('缺卡'), lines.join(' | '));
  const csv = report.renderCsv({ label: '2026-10-12 ~ 2026-10-18' }, agg);
  check('CSV 表头改「缺卡」', csv.includes('当日时长,缺卡') && !csv.includes('落单卡'), csv.split('\r\n')[0]);
  const zsRow = csv.split('\r\n').find((l) => l.startsWith('张三,zhangsan,2026-10-13'));
  check('CSV 缺卡列=1', zsRow && zsRow.endsWith(',1'), zsRow);
  const win = { label: '2026-10-12 ~ 2026-10-18' };
  const c = card.buildWeeklyCard(win, agg);
  check('有缺卡 → orange 头', c.header.template === 'orange', c.header.template);
  check('汇总行=有效班次+缺卡', c.elements[0].content.includes('有效班次 3 段') && c.elements[0].content.includes('缺卡 1 段'), c.elements[0].content);
  check('卡口径=06:00 切天', c.elements[4].content.includes('06:00') && c.elements[4].content.includes('平台上下班配对'), c.elements[4].content);
  const blocks = feishuDoc.buildDocBlocks(win, agg, sessions, { dataSource: 'feishu' });
  check('文档口径含平台配对/06:00', blocks.some((b) => b.text && b.text.elements[0].text_run.content.includes('平台上下班配对') && b.text.elements[0].text_run.content.includes('06:00')));
  check('文档汇总=有效班次', blocks.some((b) => b.text && b.text.elements[0].text_run.content.includes('有效班次 3 段')));
  check('文档明细=班段', blocks.some((b) => b.block_type === 5 && b.heading3.elements[0].text_run.content.includes('个班段')));
  check('文档明细含缺卡行', blocks.some((b) => b.text && b.text.elements[0].text_run.content.includes('缺卡') && b.text.elements[0].text_run.content.includes('张三')));
  check('文档明细含上下班区间', blocks.some((b) => b.text && b.text.elements[0].text_run.content.includes('→')));

  console.log('\n== 3. fetchTaskSessions：user_tasks 请求与归一化（mock fetch） ==');
  process.env.ZKLINK_ATT_USER_IDS = 'u1,u2';
  delete require.cache[require.resolve('../src/zklink/config')];
  delete require.cache[require.resolve('../src/zklink/feishuAttendance')];
  delete require.cache[require.resolve('../src/feishu/client')];
  const att = require('../src/zklink/feishuAttendance');
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    if (u.includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 't-sess', expire: 7200 }) };
    if (u.includes('user_tasks/query')) {
      return { json: async () => ({ code: 0, data: {
        user_task_results: [
          { user_id: 'u1', employee_name: '张三', day: 20261012, records: [
            { check_in_record: { check_time: String(sec('2026-10-12T06:00:00+08:00')) }, check_out_record: { check_time: String(sec('2026-10-12T12:00:00+08:00')) }, check_in_result: 'Normal', check_out_result: 'Normal', task_shift_type: 0 },
            { check_in_record: { check_time: String(sec('2026-10-12T13:00:00+08:00')) }, check_out_record: null, check_in_result: 'Normal', check_out_result: 'NoNeedCheck', task_shift_type: 0 },
          ] },
          { user_id: 'u2', employee_name: '李四', day: 20261013, records: [
            { check_in_record: null, check_out_record: { check_time: String(sec('2026-10-13T09:00:00+08:00')) }, check_in_result: 'Normal', check_out_result: 'Normal', task_shift_type: 0 },
            { check_in_record: { check_time: String(sec('2026-10-13T10:00:00+08:00')) }, check_out_record: { check_time: String(sec('2026-10-14T01:00:00+08:00')) }, check_in_result: 'Normal', check_out_result: 'Normal', task_shift_type: 1 },
          ] },
        ],
        invalid_user_ids: ['bad1'],
        unauthorized_user_ids: [],
      } }) };
    }
    return { json: async () => ({ code: 1, msg: `unexpected ${u}` }) };
  };
  const r = await att.fetchTaskSessions(Date.parse('2026-10-12T00:00:00+08:00'), Date.parse('2026-10-19T00:00:00+08:00'));
  const taskCall = calls.find((x) => x.url.includes('user_tasks/query'));
  check('user_tasks 查询参数 employee_type/ignore_invalid', taskCall.url.includes('employee_type=employee_id') && taskCall.url.includes('ignore_invalid_users=true'), taskCall.url);
  check('查询日期=周一~周日（06:00 工作日口径）', taskCall.body.check_date_from === 20261012 && taskCall.body.check_date_to === 20261018, JSON.stringify(taskCall.body));
  check('请求含加班班段', taskCall.body.need_overtime_result === true && taskCall.body.user_ids.join(',') === 'u1,u2', JSON.stringify(taskCall.body));
  check('归一化 4 个班段', r.sessions.length === 4, JSON.stringify(r.sessions));
  const s1 = r.sessions.find((x) => x.userid === 'u1' && x.complete);
  const s2 = r.sessions.find((x) => x.userid === 'u1' && !x.complete);
  const s3 = r.sessions.find((x) => x.userid === 'u2' && !x.checkin_time);
  const s4 = r.sessions.find((x) => x.userid === 'u2' && x.task_shift_type === 1);
  check('完整段 6h / day=10-12', s1 && s1.durationMs === min(360) && s1.day === '2026-10-12' && s1.complete === true, JSON.stringify(s1));
  check('NoNeedCheck 单边卡 missing=false', s2 && s2.missing === false && s2.checkout_time === null, JSON.stringify(s2));
  check('只有下班卡 missing=true', s3 && s3.missing === true && s3.checkin_time === null, JSON.stringify(s3));
  check('加班段跨天 15h 且计入起始日', s4 && s4.task_shift_type === 1 && s4.cross_day === true && s4.durationMs === min(900), JSON.stringify(s4));
  check('名单统计/无效名单透传', r.userCount === 2 && r.invalidUserIds.join(',') === 'bad1', JSON.stringify({ users: r.userCount, invalid: r.invalidUserIds }));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
