// 周窗口桩测试：锚点/窗口标签/键/补发判定/下次发送时刻（纯函数）
// 运行：node scripts/stub-test-zklink-window.js
const assert = require('assert');
const report = require('../src/zklink/report');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}

console.log('\n== 1. weekWindow（发送日=周一） ==');
// 2026-09-21 是周一；上海 09:30 看 → 窗口=09-14 00:00 ~ 09-21 00:00（上一完整周）
const look = Date.parse('2026-09-21T09:30:00+08:00');
const win = report.weekWindow(0, look, 1);
check('窗口标签=上一完整周', win.label === '2026-09-14 ~ 2026-09-20', win.label);
check('周键=该周周一日期', win.key === '2026-09-14', win.key);
check('窗口起点=周一 00:00 上海', new Date(win.start).toISOString() === '2026-09-13T16:00:00.000Z', new Date(win.start).toISOString());
const win1 = report.weekWindow(1, look, 1);
check('offset=1 再往前一周', win1.label === '2026-09-07 ~ 2026-09-13', win1.label);

console.log('\n== 2. 发送日前的周期归属 ==');
// 周一 08:00（未过 09:30 发送时刻）→ weekWindow(0)=今天 09:30 将播的窗口（锚=今天 00:00），
// 「该不该现在发」由 isPastSendTime 把关（watchdog 补发判定用），窗口本身不回退
const before = Date.parse('2026-09-21T08:00:00+08:00');
check('周一未到发送时刻：窗口=今日将播的 09-14 ~ 09-20', report.weekWindow(0, before, 1).label === '2026-09-14 ~ 2026-09-20', report.weekWindow(0, before, 1).label);
check('同时刻 isPastSendTime=false（不补发）', !report.isPastSendTime(before, 1, 9, 30));
// 周日 12:00 看（发送日=周一）→ 锚=上周一，窗口=09-07 ~ 09-13
const sunday = Date.parse('2026-09-20T12:00:00+08:00');
check('周日看上一完整周 09-07 ~ 09-13', report.weekWindow(0, sunday, 1).label === '2026-09-07 ~ 2026-09-13', report.weekWindow(0, sunday, 1).label);

console.log('\n== 3. 发送日=周日的形态 ==');
const winSun = report.weekWindow(0, Date.parse('2026-09-27T09:30:00+08:00'), 0);
check('周日 09:30 发送：窗口=周日 00:00 ~ 周六 24:00（09-20 ~ 09-26）', winSun.label === '2026-09-20 ~ 2026-09-26', winSun.label);

console.log('\n== 4. isPastSendTime / nextSendTime ==');
check('09:29 未到（周一 09:30）', !report.isPastSendTime(Date.parse('2026-09-21T09:29:00+08:00'), 1, 9, 30));
check('09:30 整已到', report.isPastSendTime(Date.parse('2026-09-21T09:30:00+08:00'), 1, 9, 30));
const next1 = report.nextSendTime(Date.parse('2026-09-21T09:29:00+08:00'), 1, 9, 30);
check('09:29 看下次=当天 09:30', new Date(next1).toISOString() === '2026-09-21T01:30:00.000Z', new Date(next1).toISOString());
const next2 = report.nextSendTime(Date.parse('2026-09-21T10:00:00+08:00'), 1, 9, 30);
check('已过则下周同时刻', new Date(next2).toISOString() === '2026-09-28T01:30:00.000Z', new Date(next2).toISOString());

console.log('\n== 5. 时长格式化 ==');
check('0 → 0分钟', report.fmtDuration(0) === '0分钟', report.fmtDuration(0));
check('45 分钟', report.fmtDuration(45 * 60000) === '45分钟', report.fmtDuration(45 * 60000));
check('9 小时整', report.fmtDuration(9 * 3600000) === '9小时', report.fmtDuration(9 * 3600000));
check('9小时07分钟', report.fmtDuration(547 * 60000) === '9小时7分钟', report.fmtDuration(547 * 60000));
check('负值按 0', report.fmtDuration(-5) === '0分钟', report.fmtDuration(-5));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
