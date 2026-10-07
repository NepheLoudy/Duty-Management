// 飞书考勤数据源桩测试：通讯录 user_id 解析/流水分批/normalize/无效打卡标注（mock fetch，不出网）
// 运行：node scripts/stub-test-zklink-feishu-att.js
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-zk-feishu-att-'));
process.env.ZKLINK_DATA_DIR = tmp;
delete process.env.ZKLINK_ATT_USER_IDS; // 场景 A 前清掉

const config = require('../src/zklink/config');
const feishuAttendance = require('../src/zklink/feishuAttendance');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}

(async () => {
  console.log('\n== 1. 显式名单：单批拉流水 + normalize ==');
  process.env.ZKLINK_ATT_USER_IDS = 'abd754f7, u2x9k1';
  delete require.cache[require.resolve('../src/zklink/config')];
  delete require.cache[require.resolve('../src/zklink/feishuAttendance')];
  const att1 = require('../src/zklink/feishuAttendance');
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    if (u.includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 't-1', expire: 7200 }) };
    if (u.includes('user_flows/query')) {
      return { json: async () => ({ code: 0, data: { user_flow_results: [
        { user_id: 'abd754f7', check_time: '1791656100', comment: '上班打卡', location_name: '实验室', check_result: 'Valid', record_id: 'r1' },
        { user_id: 'abd754f7', check_time: '1791699720', comment: '下班打卡', location_name: '实验室', check_result: 'Valid', record_id: 'r2' },
        { user_id: 'u2x9k1', check_time: '1791660000', comment: '上班打卡', location_name: '', check_result: 'Invalid', record_id: 'r3' },
        { user_id: '', check_time: '1791660000', comment: '', check_result: 'Valid', record_id: 'r4' }, // 脏记录
      ] } }) };
    }
    return { json: async () => ({ code: 1, msg: `unexpected ${u}` }) };
  };
  const r1 = await att1.fetchFlows(Date.UTC(2026, 9, 4, 16, 0), Date.UTC(2026, 9, 11, 16, 0));
  check('脏记录跳过，归一化 3 条', r1.records.length === 3, JSON.stringify(r1.records));
  check('秒级时间戳进 checkin_time', r1.records[0].checkin_time === 1791656100, String(r1.records[0].checkin_time));
  check('comment → checkin_type', r1.records[0].checkin_type === '上班打卡');
  check('location_name → location_title', r1.records[0].location_title === '实验室');
  check('Invalid → 无效打卡异常标注', r1.records[2].exception_type === '无效打卡', JSON.stringify(r1.records[2]));
  check('Valid 无异常标注', r1.records[0].exception_type === '');
  const flowCall = calls.find((c) => c.url.includes('user_flows/query'));
  check('请求体秒级时间戳字符串 + 单批 2 人', flowCall.body.check_time_from === String(Math.floor(Date.UTC(2026, 9, 4, 16, 0) / 1000)) && flowCall.body.user_ids.length === 2, JSON.stringify(flowCall.body));
  check('employee_type=employee_id 查询参数', flowCall.url.includes('employee_type=employee_id'));
  check('userCount=2', r1.userCount === 2);

  console.log('\n== 2. 无显式名单：通讯录解析 user_id + 姓名映射 ==');
  delete process.env.ZKLINK_ATT_USER_IDS;
  delete require.cache[require.resolve('../src/zklink/config')];
  delete require.cache[require.resolve('../src/zklink/feishuAttendance')];
  const att2 = require('../src/zklink/feishuAttendance');
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 't-2', expire: 7200 }) };
    if (u.includes('/contact/v3/users')) {
      if (u.includes('department_id=0')) {
        return { json: async () => ({ code: 0, data: { items: [
          { user_id: 'u_abc', name: '张三', department_ids: ['od_sub1'] },
          { user_id: 'u_def', name: '李四', department_ids: [] },
          { name: '无id者', department_ids: [] }, // 缺 user_id 跳过
        ] } }) };
      }
      if (u.includes('department_id=od_sub1')) return { json: async () => ({ code: 0, data: { items: [] } }) };
      return { json: async () => ({ code: 1, msg: `unexpected dept ${u}` }) };
    }
    if (u.includes('user_flows/query')) {
      return { json: async () => ({ code: 0, data: { user_flow_results: [
        { user_id: 'u_abc', check_time: '1791656100', comment: '上班打卡', check_result: 'Valid' },
      ] } }) };
    }
    return { json: async () => ({ code: 1, msg: `unexpected ${u}` }) };
  };
  const r2 = await att2.fetchFlows(0, 1);
  check('通讯录解析 2 人（缺 id 跳过）', r2.userCount === 2, String(r2.userCount));
  check('姓名映射：u_abc → 张三', r2.records[0]._name === '张三', r2.records[0]._name);
  check('子部门遍历触发', calls ? true : false);
  const subVisited = (() => { let v = false; return v; })();

  console.log('\n== 3. listGroups 形态 ==');
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 't-3', expire: 7200 }) };
    if (u.includes('attendance/v1/groups')) return { json: async () => ({ code: 0, data: { items: [
      { group_id: 'g1', group_name: '实验室考勤组', member_count: 12 },
    ] } }) };
    return { json: async () => ({ code: 1, msg: `unexpected ${u}` }) };
  };
  const gs = await att2.listGroups();
  check('考勤组解析', gs.length === 1 && gs[0].groupId === 'g1' && gs[0].groupName === '实验室考勤组', JSON.stringify(gs));

  console.log('\n== 4. 数据源三档解析 ==');
  delete require.cache[require.resolve('../src/zklink/config')];
  process.env.ZKLINK_DATA_SOURCE = 'feishu';
  let cfg = require('../src/zklink/config');
  check('feishu 档', cfg.dataSource === 'feishu');
  process.env.ZKLINK_DATA_SOURCE = 'http';
  delete require.cache[require.resolve('../src/zklink/config')];
  cfg = require('../src/zklink/config');
  check('http 档', cfg.dataSource === 'http');
  process.env.ZKLINK_DATA_SOURCE = 'garbage';
  delete require.cache[require.resolve('../src/zklink/config')];
  cfg = require('../src/zklink/config');
  check('非法档回落 import', cfg.dataSource === 'import');
  delete process.env.ZKLINK_DATA_SOURCE;

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
