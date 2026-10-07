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

  console.log('\n== 2. 无显式名单：通讯录解析 user_id + 姓名映射（含子部门递归） ==');
  delete process.env.ZKLINK_ATT_USER_IDS;
  delete require.cache[require.resolve('../src/zklink/config')];
  delete require.cache[require.resolve('../src/zklink/feishuAttendance')];
  const att2 = require('../src/zklink/feishuAttendance');
  const visitedDepts = new Set();
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 't-2', expire: 7200 }) };
    if (u.includes('/contact/v3/users')) {
      const m = u.match(/department_id=([^&]+)/);
      if (m) visitedDepts.add(decodeURIComponent(m[1]));
      if (u.includes('department_id=0')) {
        return { json: async () => ({ code: 0, data: { items: [
          { user_id: 'u_abc', name: '张三', department_ids: ['od_sub1'] },
          { user_id: 'u_def', name: '李四', department_ids: [] },
          { name: '无id者', department_ids: [] }, // 缺 user_id 跳过
        ] } }) };
      }
      if (u.includes('department_id=od_sub1')) {
        return { json: async () => ({ code: 0, data: { items: [
          { user_id: 'u_sub', name: '王五', department_ids: [] }, // 只在子部门，递归遍历才能拉到
        ] } }) };
      }
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
  check('通讯录解析 3 人（缺 id 跳过 + 子部门递归拉到王五）', r2.userCount === 3, String(r2.userCount));
  check('子部门 od_sub1 真被遍历', visitedDepts.has('od_sub1'), [...visitedDepts].join(','));
  check('姓名映射：u_abc → 张三', r2.records[0]._name === '张三', r2.records[0]._name);

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

  console.log('\n== 5. 考勤组成员解析（考勤组规则口径：未打卡者 0 时长呈现） ==');
  process.env.ZKLINK_ATT_GROUP_NAME = '实验室考勤组';
  delete require.cache[require.resolve('../src/zklink/config')];
  delete require.cache[require.resolve('../src/zklink/feishuAttendance')];
  const att5 = require('../src/zklink/feishuAttendance');
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 't-5', expire: 7200 }) };
    if (u.includes('attendance/v1/groups')) return { json: async () => ({ code: 0, data: { items: [
      { group_id: 'g9', group_name: '实验室考勤组', member_count: 2, member: { member_type: 'acy', member_list: [{ id: 'u_abc' }, { id: 'u_ghost' }] } },
    ] } }) };
    if (u.includes('/contact/v3/users')) return { json: async () => ({ code: 0, data: { items: [
      { user_id: 'u_abc', name: '张三', department_ids: [] },
      { user_id: 'u_def', name: '李四', department_ids: [] },
    ] } }) };
    return { json: async () => ({ code: 1, msg: `unexpected ${u}` }) };
  };
  const gm5 = await att5.resolveGroupMembers();
  check('组名匹配 + 成员解析 2 人', gm5.members && gm5.members.length === 2 && gm5.group.groupId === 'g9', JSON.stringify(gm5));
  check('成员带通讯录姓名', gm5.members[0].name === '张三', JSON.stringify(gm5.members[0]));
  check('通讯录外成员 userid 兜底姓名', gm5.members[1].name === 'u_ghost', JSON.stringify(gm5.members[1]));

  console.log('\n== 6. 组选择回退：唯一组自动取用 / 响应无成员给 reason ==');
  process.env.ZKLINK_ATT_GROUP_NAME = ''; // 空串遮蔽 .env 真值（dotenv 兜底不覆盖已存在 env）
  delete require.cache[require.resolve('../src/zklink/config')];
  delete require.cache[require.resolve('../src/zklink/feishuAttendance')];
  const att6 = require('../src/zklink/feishuAttendance');
  const gm6 = await att6.resolveGroupMembers();
  check('未配置组 → null+原因', gm6.members === null && String(gm6.reason).includes('未配置考勤组'), JSON.stringify(gm6));
  process.env.ZKLINK_ATT_GROUP_NAME = '实验室考勤组';
  delete require.cache[require.resolve('../src/zklink/config')];
  delete require.cache[require.resolve('../src/zklink/feishuAttendance')];
  const att6b = require('../src/zklink/feishuAttendance');
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 't-6', expire: 7200 }) };
    if (u.includes('attendance/v1/groups')) return { json: async () => ({ code: 0, data: { items: [
      { group_id: 'g9', group_name: '实验室考勤组', member_count: 5 }, // 无 member 字段
    ] } }) };
    if (u.includes('/contact/v3/users')) return { json: async () => ({ code: 0, data: { items: [] } }) };
    return { json: async () => ({ code: 1, msg: `unexpected ${u}` }) };
  };
  const gm6b = await att6b.resolveGroupMembers();
  check('响应无成员列表 → null+权限提示', gm6b.members === null && String(gm6b.reason).includes('member_count=5'), JSON.stringify(gm6b));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
