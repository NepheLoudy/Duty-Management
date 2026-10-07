// 打卡时长聚合桩测试：口径（末卡−首卡/孤条/缺勤）/跨日切断/CSV/卡片行（纯函数）
// 运行：node scripts/stub-test-zklink-duration.js
const assert = require('assert');
const report = require('../src/zklink/report');
const { filterByWindow, deriveMembers, mergeMembers } = require('../src/zklink/importService');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}

const sec = (s) => Math.floor(Date.parse(s) / 1000); // 带 +08:00 的上海挂钟 → 秒

// 窗口：2026-09-14 00:00 ~ 09-21 00:00（上海）
const look = Date.parse('2026-09-21T09:30:00+08:00');
const win = report.weekWindow(0, look, 1);

// 原始记录流（乱序给入，聚合内排序）
const records = [
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-14T18:02:00+08:00') }, // 乱序：先给末卡
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-14T08:55:00+08:00') },
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-15T09:00:00+08:00') }, // 孤条日
  { userid: 'lisi', _name: '李四', checkin_time: sec('2026-09-14T12:00:00+08:00') },
  { userid: 'lisi', _name: '李四', checkin_time: sec('2026-09-14T08:00:00+08:00') },
  { userid: 'lisi', _name: '李四', checkin_time: sec('2026-09-14T18:00:00+08:00') },
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-16T23:50:00+08:00') }, // 跨日切断：两孤条日
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-17T00:10:00+08:00') },
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-21T09:00:00+08:00') }, // 窗口外（下周一）
  { userid: 'zhaoliu', _name: '赵六', checkin_time: sec('2026-09-14T09:00:00+08:00') },  // 名单外
  { userid: 'zhaoliu', _name: '赵六', checkin_time: sec('2026-09-14T17:00:00+08:00') },
];
const members = [
  { userid: 'zhangsan', name: '张三' },
  { userid: 'lisi', name: '李四' },
  { userid: 'wangwu', name: '王五' }, // 整周无记录
];

const inWin = filterByWindow(records, win);
check('窗口过滤：窗外下周一记录被滤掉', inWin.length === 10, String(inWin.length));

const agg = report.aggregateDuration(inWin, members);

console.log('\n== 1. 按人聚合 ==');
const zs = agg.users.find((u) => u.userid === 'zhangsan');
const ls = agg.users.find((u) => u.userid === 'lisi');
const ww = agg.users.find((u) => u.userid === 'wangwu');
const zl = agg.users.find((u) => u.userid === 'zhaoliu');
check('张三打卡 2 天 3+2=5 条', zs && zs.punchDays === 4 && zs.punches === 5, JSON.stringify(zs && { d: zs.punchDays, p: zs.punches }));
check('张三周一 09-14 时长=末卡−首卡（9小时7分钟）', zs.days[0].durationMs === 547 * 60000, String(zs.days[0].durationMs));
check('张三周二孤条（时长 0 + lonely 标记）', zs.days[1].lonely === true && zs.days[1].durationMs === 0);
check('张三跨日切断：23:50 与次日 00:10 各成孤条日', zs.lonelyDays === 3, String(zs.lonelyDays));
check('张三周合计=仅周一 9小时7分钟', zs.totalMs === 547 * 60000, String(zs.totalMs));
check('李四单日 3 条=10 小时（首尾卡）', ls.days[0].count === 3 && ls.days[0].durationMs === 600 * 60000 && ls.lonelyDays === 0, JSON.stringify(ls.days[0]));
check('王五整周无记录仍列出（0 天）', ww && ww.punchDays === 0 && ww.totalMs === 0);
check('名单外赵六 unknown 标记+姓名兜底', zl && zl.known === false && zl.name === '赵六');

console.log('\n== 2. 汇总 ==');
check('totals.punches=10', agg.totals.punches === 10, JSON.stringify(agg.totals));
check('totals.punchUsers=3（含名单外）', agg.totals.punchUsers === 3);
check('totals.lonelyDays=4（张三 3 + 赵六 0）', agg.totals.lonelyDays === 3, String(agg.totals.lonelyDays));
check('totals.totalMs=张三547+李四600+赵六480 分钟', agg.totals.totalMs === (547 + 600 + 480) * 60000, String(agg.totals.totalMs));
check('dayRows=6 个有打卡日（张三4 + 李四1 + 赵六1）', agg.dayRows.length === 6, String(agg.dayRows.length));

console.log('\n== 3. CSV 日明细 ==');
const csv = report.renderCsv(win, agg);
check('BOM 头', csv.charCodeAt(0) === 0xFEFF);
const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
check('表头 8 列', lines[0] === '姓名,userid,日期,星期,首卡,末卡,打卡条数,当日时长', lines[0]);
const zsRow = lines.find((l) => l.startsWith('张三') && l.includes('2026-09-14'));
check('张三 09-14 行：首卡 08:55 / 末卡 18:02 / 9小时7分钟', /\d{4}-09-14,周一,08:55,18:02,2,9小时7分钟/.test(zsRow), zsRow);

console.log('\n== 4. 卡片行 ==');
const userLines = report.renderUserLines(agg);
check('每人一行含时长', userLines.some((l) => l.includes('**张三**') && l.includes('9小时7分钟') && l.includes('孤条 3 天')), userLines.join(' | '));
check('王五 0 天也有一行', userLines.some((l) => l.includes('**王五**：0 天')), userLines.join(' | '));
const truncated = report.renderUserLines(agg, { maxUserLines: 2 });
check('超限截断提示指向云文档', truncated.length === 3 && truncated[2].includes('云文档留档'), truncated.join(' | '));

console.log('\n== 5. 名单派生/合并 ==');
const derived = deriveMembers(inWin);
check('名单去重=3 人（从记录派生，零记录的王五不在内）', derived.length === 3, JSON.stringify(derived.map((m) => m.userid)));
const merged = mergeMembers(members, derived);
check('既有名册保留 + 赵六追加', merged.length === 4 && merged.some((m) => m.userid === 'zhaoliu'), JSON.stringify(merged.map((m) => m.userid)));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
