/**
 * 离线桩测试 · 多维表格归档分支（2026-10-12，wecom 废止批后周报排障的落地件）：
 *   归档落点=wiki「打卡记录」bitable（曼波指定），resolveDocToken 解析出 objType=bitable
 *   时 archiveToDoc 自动分派 archiveToBitable——按人每周一行（人员/该周时长/是否及格/第几周）。
 *   验证：
 *     ①wiki 节点 objType=bitable 分派进表格分支（docx API 不再被误调）；
 *     ②字段按 type 识别（11 人员/1 时长文本/7 及格/2 周数，字段名无关）；
 *     ③「第几周」按 ZKLINK_WEEK1_START 锚点换算（2026-09-14 起，2026-10-05 窗口=第 5 周）；
 *     ④及格列按 ZKLINK_PASS_HOURS 判定（11h→true / 8h→false）；
 *     ⑤通讯录可见范围外的人（无 open_id）人员列留空但行照写（不阻塞归档）；
 *     ⑥同周已有行跳过（幂等，重试/手动重跑不重复写）。
 * 全局 fetch 全桩（token/wiki/fields/records/batch_create/contact），积压文件指向临时目录。
 * 用法：node scripts/stub-test-zklink-bitable.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.APP_ID = 'cli_test';
process.env.APP_SECRET = 'sec_test';
process.env.ZKLINK_ARCHIVE_DOC_TOKEN = 'NFUtestwikitoken';
process.env.ZKLINK_ARCHIVE_TABLE_ID = 'tblTEST';
process.env.ZKLINK_WEEK1_START = '2026-09-07';
process.env.ZKLINK_PASS_HOURS = '10';
process.env.ZKLINK_DATA_DIR = path.join(os.tmpdir(), `zklink-bitable-test-${Date.now()}`);

const realFetch = global.fetch;
let calls = [];
let batchPayloads = [];
let existingWeekRows = [];

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('/auth/v3/tenant_access_token')) return jsonResponse({ code: 0, tenant_access_token: 'T', expire: 7200 });
  if (u.includes('/wiki/v2/spaces/get_node')) return jsonResponse({ code: 0, data: { node: { obj_token: 'APPBITABLE', obj_type: 'bitable', title: '打卡记录' } } });
  if (u.includes('/bitable/v1/apps/APPBITABLE/tables/tblTEST/fields')) {
    return jsonResponse({ code: 0, data: { items: [
      { field_id: 'fUser', field_name: '文本', type: 11 },
      { field_id: 'fDur', field_name: '该周时长', type: 1 },
      { field_id: 'fPass', field_name: '是否及格', type: 7 },
      { field_id: 'fWeek', field_name: '第几周', type: 2 },
    ] } });
  }
  if (u.includes('/records/batch_create')) {
    batchPayloads.push(JSON.parse(opts.body));
    return jsonResponse({ code: 0, data: { records: [] } });
  }
  if (u.includes('/tables/tblTEST/records?')) {
    // 查重端点：existingWeekRows 非空时返回一条第 5 周行
    return jsonResponse({ code: 0, data: { items: existingWeekRows.map((w) => ({ record_id: 'r' + w, fields: { '第几周': w } })), total: existingWeekRows.length } });
  }
  if (u.includes('/contact/v3/users')) {
    // 通讯录桩：仅 2 人可见，fb5eg5d6（李子杰）在可见范围外 → 无 open_id
    return jsonResponse({ code: 0, data: { items: [
      { user_id: 'uu_zhang', name: '张三', open_id: 'ou_zhang', department_ids: ['0'] },
      { user_id: 'uu_li', name: '李四', open_id: 'ou_li', department_ids: ['0'] },
    ] } });
  }
  throw new Error('stub-fetch 未覆盖的 URL: ' + u);
};

const feishuDoc = require(path.join(__dirname, '..', 'src/zklink/feishuDoc.js'));

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

// 归档窗口：2026-10-05（上海周一 00:00）为起点的墙钟 ms（UTC 前一日 16:00）
const WIN_START_WALL = Date.UTC(2026, 9, 4, 16, 0, 0);
const win = { startWall: WIN_START_WALL, endWall: WIN_START_WALL + 7 * 86400000, key: '2026-10-05', label: '2026-10-05 ~ 2026-10-11' };
const agg = {
  users: [
    { userid: 'uu_zhang', name: '张三', known: true, punchDays: 3, punches: 5, lonelyDays: 1, totalMs: 11 * 3600000, days: [] }, // 11h → 及格
    { userid: 'uu_li', name: '李四', known: true, punchDays: 2, punches: 2, lonelyDays: 2, totalMs: 8 * 3600000, days: [] },   // 8h → 不及格
    { userid: 'fb5eg5d6', name: '李子杰', known: false, punchDays: 2, punches: 3, lonelyDays: 1, totalMs: 159 * 60000, days: [] }, // 无 open_id
  ],
  totals: { punches: 10, users: 3, punchUsers: 3, lonelyDays: 3, totalMs: 0 },
  dayRows: [], rawRecords: [], userNames: new Map(),
};

(async () => {
  console.log('== 1. objType=bitable 分派与行写入 ==');
  const r = await feishuDoc.archiveToDoc(win, agg, [], { dataSource: 'feishu' });
  check('分派进 bitable 分支（objType=bitable）', r.objType === 'bitable');
  check('三人各写一行', r.appended === 3, `appended=${r.appended}`);
  check('batch_create 恰一调用（≤500 单批）', batchPayloads.length === 1);
  const rows = (batchPayloads[0] && batchPayloads[0].records) || [];
  check('第 1 行：人员列=open_id + 时长文本 + 及格true + 周数5', (() => {
    const f = rows[0] && rows[0].fields;
    return f && f['文本'] && f['文本'][0].id === 'ou_zhang' && f['该周时长'] === '11小时' && f['是否及格'] === true && f['第几周'] === 5;
  })(), JSON.stringify(rows[0]));
  check('第 2 行：8h 判不及格', rows[1] && rows[1].fields['是否及格'] === false && rows[1].fields['第几周'] === 5, JSON.stringify(rows[1]));
  console.log('== 2. 可见范围外人员降级 ==');
  check('李子杰无 open_id：人员列留空但行照写（时长/周数在）', rows[2] && !rows[2].fields['文本'] && rows[2].fields['该周时长'] === '2小时39分钟' && rows[2].fields['第几周'] === 5, JSON.stringify(rows[2]));
  console.log('== 3. 同周幂等跳过 ==');
  batchPayloads.length = 0;
  existingWeekRows = [5];
  const r2 = await feishuDoc.archiveToDoc(win, agg, [], { dataSource: 'feishu' });
  check('已有第 5 周行：appended=0 且不再发 batch_create', r2.appended === 0 && batchPayloads.length === 0 && r2.skipped === true);
  console.log('== 4. 周数换算边界 ==');
  const w1 = feishuDoc.weekNumberOf({ startWall: Date.UTC(2026, 8, 6, 16, 0, 0) }); // 2026-09-07 周一
  const w6 = feishuDoc.weekNumberOf({ startWall: Date.UTC(2026, 9, 11, 16, 0, 0) }); // 2026-10-12 周一
  check('学期第 1 周周一=第 1 周', w1 === 1, `w1=${w1}`);
  check('2026-10-12 当周=第 6 周', w6 === 6, `w6=${w6}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  global.fetch = realFetch;
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('桩测试执行异常:', e); global.fetch = realFetch; process.exit(1); });
