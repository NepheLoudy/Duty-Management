// 打卡明细导入桩测试：xlsx 内存造表 → 单列时间/日期时间分列/多时间列防呆/名单合并
// 运行：node scripts/stub-test-zklink-import.js
const assert = require('assert');
const XLSX = require('xlsx');
const { parseWorkbook, mergeMembers, filterByWindow, deriveMembers, toShanghaiMs } = require('../src/zklink/importService');
const report = require('../src/zklink/report');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}
function makeBuf(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '打卡明细');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

console.log('\n== 1. 单列完整时间（字符串 / Date / 序列号） ==');
const serial = Date.UTC(2026, 9, 5, 8, 55) / 86400000 + 25569; // Excel 序列号（UTC 分量=上海挂钟 08:55，与 xlsx cellDates 回读约定一致）
const buf1 = makeBuf([
  ['姓名', '工号', '打卡时间', '打卡状态', '考勤组'],
  ['张三', 'zhangsan', '2026/10/5 8:55', '上班', '实验室考勤组'],
  ['张三', 'zhangsan', new Date(Date.UTC(2026, 9, 5, 10, 2, 0)), '下班', '实验室考勤组'], // Date 单元格：UTC 分量=上海挂钟
  ['李四', 'lisi', serial, '', '实验室考勤组'],
  ['王五', '', '2026-10-06 09:00:00', '上班', ''], // 无工号 → 姓名兜底 userid
]);
const p1 = parseWorkbook(buf1);
check('记录数=4', p1.records.length === 4, String(p1.records.length));
check('列识别含 姓名/工号/打卡时间', ['name', 'userid', 'time'].every((f) => p1.matched.some((m) => m.startsWith(f))), JSON.stringify(p1.matched));
check('字符串时间按上海时区（08:55+08:00）', new Date(p1.records[0].checkin_time * 1000).toISOString() === '2026-10-05T00:55:00.000Z', new Date(p1.records[0].checkin_time * 1000).toISOString());
// Date/序列号单元格走 Excel 序列浮点往返，允许 ±2s 精度损失（时长粒度=分钟，无影响）
const near = (sec, iso) => Math.abs(p1.records ? sec * 1000 - Date.parse(iso) : Infinity) <= 2000;
check('Date 单元格（10:02+08:00，±2s）', near(p1.records[1].checkin_time, '2026-10-05T02:02:00.000Z'), new Date(p1.records[1].checkin_time * 1000).toISOString());
check('Excel 序列号单元格（08:55+08:00，±2s）', near(p1.records[2].checkin_time, '2026-10-05T00:55:00.000Z'), new Date(p1.records[2].checkin_time * 1000).toISOString());
check('userid 取自「工号」', p1.records[0].userid === 'zhangsan', p1.records[0].userid);
check('无工号者 userid 兜底姓名', p1.records[3].userid === '王五' && p1.records[3]._name === '王五', JSON.stringify(p1.records[3]));
check('状态/考勤组透传', p1.records[0].checkin_type === '上班' && p1.records[0].groupname === '实验室考勤组');

console.log('\n== 2. 日期+时间 两列分列（ZKLink 导出常见形态） ==');
const buf2 = makeBuf([
  ['姓名', '工号', '日期', '时间', '考勤组'],
  ['张三', 'zhangsan', '2026/10/5', '08:55', '实验室考勤组'],
  ['张三', 'zhangsan', '2026-10-05', '18:02:00', '实验室考勤组'],
  ['李四', 'lisi', '2026/10/6', '9:00', '实验室考勤组'],
]);
const p2 = parseWorkbook(buf2);
check('记录数=3（split 模式）', p2.records.length === 3, String(p2.records.length));
check('分列合成时间（08:55+08:00）', new Date(p2.records[0].checkin_time * 1000).toISOString() === '2026-10-05T00:55:00.000Z', new Date(p2.records[0].checkin_time * 1000).toISOString());
check('带秒的时间列（18:02+08:00）', new Date(p2.records[1].checkin_time * 1000).toISOString() === '2026-10-05T10:02:00.000Z', new Date(p2.records[1].checkin_time * 1000).toISOString());
check('跨日（次日 9:00）', new Date(p2.records[2].checkin_time * 1000).toISOString() === '2026-10-06T01:00:00.000Z', new Date(p2.records[2].checkin_time * 1000).toISOString());

console.log('\n== 3. 日期列 + 完整时间列并存 → 单列模式优先 ==');
const buf3 = makeBuf([
  ['姓名', '日期', '打卡时间'],
  ['张三', '2026/10/5', '2026/10/5 08:55'],
]);
const p3 = parseWorkbook(buf3);
check('时间列是完整时间 → 不做分列合成', new Date(p3.records[0].checkin_time * 1000).toISOString() === '2026-10-05T00:55:00.000Z', new Date(p3.records[0].checkin_time * 1000).toISOString());

console.log('\n== 4. 多时间列（上下班分列统计模板）→ 明确报错 ==');
let msg4 = '';
try { parseWorkbook(makeBuf([['姓名', '上班时间', '下班时间'], ['张三', '08:55', '18:02']])); } catch (e) { msg4 = e.message; }
check('报错提示模板问题', msg4.includes('检测到 2 个时间列') && msg4.includes('打卡记录明细'), msg4);

console.log('\n== 5. 缺列 → 明确报错 ==');
let msg5 = '';
try { parseWorkbook(makeBuf([['foo', 'bar'], [1, 2]])); } catch (e) { msg5 = e.message; }
check('缺姓名/时间列报错并列出全部表头', msg5.includes('报表缺关键列') && msg5.includes('foo'), msg5);
let msg5b = '';
try { parseWorkbook(makeBuf([['姓名', '部门'], ['张三', '宣运组']])); } catch (e) { msg5b = e.message; }
check('缺时间列报错', msg5b.includes('报表缺时间列'), msg5b);

console.log('\n== 6. 脏行容忍 ==');
const p6 = parseWorkbook(makeBuf([
  ['姓名', '工号', '打卡时间'],
  ['', '', '2026/10/5 08:55'], // 姓名账号全空：合并单元格续行，跳过防幽灵用户
  ['', 'zhaoliu', '2026/10/5 08:55'], // 姓名空+工号非空 → 姓名取工号
]));
check('有效记录数=1（全空行被跳过）', p6.records.length === 1 && p6.skipped === 1, JSON.stringify({ n: p6.records.length, skipped: p6.skipped }));
check('姓名空+工号非空 → 姓名取工号', p6.records[0]._name === 'zhaoliu' && p6.records[0].userid === 'zhaoliu', JSON.stringify(p6.records[0]));

console.log('\n== 7. 窗口过滤与名单链路 ==');
const look = Date.parse('2026-10-12T09:30:00+08:00'); // 周一，窗口=10-05 ~ 10-11
const win = report.weekWindow(0, look, 1);
check('窗口标签', win.label === '2026-10-05 ~ 2026-10-11', win.label);
const inWin = filterByWindow(p2.records, win);
check('10-05/06 记录全在窗口内', inWin.length === 3, String(inWin.length));
const winOut = report.weekWindow(1, look, 1);
check('上一窗口过滤为空', filterByWindow(p2.records, winOut).length === 0);
const agg = report.aggregateDuration(inWin, mergeMembers([], deriveMembers(inWin)));
check('聚合兼容：张三周一 9小时7分钟', agg.users.find((u) => u.userid === 'zhangsan').totalMs === 547 * 60000, JSON.stringify(agg.totals));

console.log('\n== 8. toShanghaiMs 基础 ==');
check('null/空 → null', toShanghaiMs('') === null && toShanghaiMs(null) === null);
check('不可解析字符串 → null', toShanghaiMs('hello') === null);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
