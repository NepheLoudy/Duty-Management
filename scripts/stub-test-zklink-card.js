// 打卡周报卡 + docx 块构造桩测试（归并版：发送走 ../feishu/webhook.js 不在本模块重测）
// 运行：node scripts/stub-test-zklink-card.js
const assert = require('assert');
const card = require('../src/zklink/card');
const feishuDoc = require('../src/zklink/feishuDoc');
const report = require('../src/zklink/report');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}

const win = report.weekWindow(0, Date.parse('2026-09-21T09:30:00+08:00'), 1);
const sec = (s) => Math.floor(Date.parse(s) / 1000);
const records = [
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-14T08:55:00+08:00') },
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-14T18:02:00+08:00') },
  { userid: 'zhangsan', _name: '张三', checkin_time: sec('2026-09-15T09:00:00+08:00') }, // 孤条 → orange
];
const agg = report.aggregateDuration(records, [{ userid: 'zhangsan', name: '张三' }]);

console.log('\n== 1. 周报卡片 ==');
const cardOrange = card.buildWeeklyCard(win, agg);
check('有孤条 → orange 头', cardOrange.header.template === 'orange', cardOrange.header.template);
check('标题含周窗口', cardOrange.header.title.content.includes('2026-09-14 ~ 2026-09-20'), cardOrange.header.title.content);
check('汇总行含总时长', cardOrange.elements[0].content.includes('9小时7分钟'), cardOrange.elements[0].content);
check('孤条入卡片', cardOrange.elements[0].content.includes('孤条 1 天'), cardOrange.elements[0].content);
const aggClean = report.aggregateDuration(records.slice(0, 2), [{ userid: 'zhangsan', name: '张三' }]);
check('全勤 → green 头', card.buildWeeklyCard(win, aggClean).header.template === 'green');
const aggEmpty = report.aggregateDuration([], [{ userid: 'zhangsan', name: '张三' }]);
check('空数据 → 提示检查导出', card.buildWeeklyCard(win, aggEmpty).elements[2].content.includes('无打卡记录'));

console.log('\n== 2. docx 块构造 ==');
const tb = feishuDoc.textBlock('hello');
check('文本块 block_type=2', tb.block_type === 2 && tb.text.elements[0].text_run.content === 'hello');
const hb = feishuDoc.headingBlock(2, '标题');
check('heading2 块 block_type=4', hb.block_type === 4 && hb.heading2.elements[0].text_run.content === '标题');

const blocks = feishuDoc.buildDocBlocks(win, agg, records, { dataSource: 'import', groupLabel: '实验室考勤组' });
check('首块=heading2 周标题', blocks[0].block_type === 4 && blocks[0].heading2.elements[0].text_run.content.includes('2026-09-14 ~ 2026-09-20'), JSON.stringify(blocks[0]).slice(0, 120));
check('含口径说明', blocks.some((b) => b.text && b.text.elements[0].text_run.content.includes('末卡 − 首卡')));
check('汇总行含总时长', blocks.some((b) => b.text && b.text.elements[0].text_run.content.includes('9小时7分钟')));
check('每人汇总行', blocks.some((b) => b.text && b.text.elements[0].text_run.content.includes('张三（zhangsan）：2 天')));
const detailIdx = blocks.findIndex((b) => b.block_type === 5 && b.heading3.elements[0].text_run.content.includes('打卡明细'));
check('明细段=heading3', detailIdx > 0 && blocks[detailIdx].heading3.elements[0].text_run.content.includes('全部 3 条记录'), JSON.stringify(blocks[detailIdx] || {}).slice(0, 120));
check('逐条记录块=3', blocks.filter((b, i) => i > detailIdx && b.text && b.text.elements[0].text_run.content.includes('张三（zhangsan）')).length === 3);

console.log('\n== 3. 空记录 → 占位行 ==');
const emptyBlocks = feishuDoc.buildDocBlocks(win, report.aggregateDuration([], []), []);
check('空记录占位', emptyBlocks.some((b) => b.text && b.text.elements[0].text_run.content.includes('本窗口无打卡记录')));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
