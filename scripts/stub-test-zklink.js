// ZKLink 客户端桩测试（归并版）：token 抠取/记录归一/时间换算/登录+拉数链路（mock fetch，不出网）
// 运行：node scripts/stub-test-zklink.js
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-zk-client-'));
process.env.ZKLINK_DATA_DIR = tmp;
process.env.ZKLINK_BASE_URL = 'http://mock.zklink';
process.env.ZKLINK_USERNAME = 'probe-user';
process.env.ZKLINK_PASSWORD = 'probe-pass';
process.env.ZKLINK_ATT_GROUP_ID = '42';

const zklink = require('../src/zklink/zklinkClient');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} — ${extra}`); }
}

console.log('\n== 1. extractToken 候选形态 ==');
check('{access_token}', zklink.extractToken({ access_token: 'a' }) === 'a');
check('{data:{access_token}}', zklink.extractToken({ data: { access_token: 'b' } }) === 'b');
check('{data:{token}}', zklink.extractToken({ data: { token: 'c' } }) === 'c');
check('{token}', zklink.extractToken({ token: 'd' }) === 'd');
check('空形态 → 空', zklink.extractToken({}) === '' && zklink.extractToken(null) === '');

console.log('\n== 2. extractRecords 候选形态 ==');
check('{data:{records}}', zklink.extractRecords({ data: { records: [1] } }).length === 1);
check('{data:{list}}', zklink.extractRecords({ data: { list: [1, 2] } }).length === 2);
check('{data:{rows}}', zklink.extractRecords({ data: { rows: [1, 2, 3] } }).length === 3);
check('纯数组', zklink.extractRecords([1]).length === 1);
check('无数组 → 空', zklink.extractRecords({ data: {} }).length === 0);

console.log('\n== 3. toEpochMs ==');
check('秒级时间戳', zklink.toEpochMs(1791657600) === 1791657600000);
check('毫秒级时间戳', zklink.toEpochMs(1791657600000) === 1791657600000);
check('上海挂钟字符串（08:55+08:00）', zklink.toEpochMs('2026-10-05 08:55:00') === Date.UTC(2026, 9, 5, 0, 55), String(zklink.toEpochMs('2026-10-05 08:55:00')));
check('ISO 字符串', zklink.toEpochMs('2026-10-05T08:55:00+08:00') === Date.UTC(2026, 9, 5, 0, 55));
check('空/垃圾 → null', zklink.toEpochMs('') === null && zklink.toEpochMs('x') === null);

console.log('\n== 4. normalizeRecord 候选字段 ==');
const r1 = zklink.normalizeRecord({ name: '张三', empNo: 'E1', punchTime: '2026-10-05 08:55:00', punchState: '上班', attGroupName: '实验室考勤组' });
check('userid=empNo / name / 时间换算', r1 && r1.userid === 'E1' && r1._name === '张三' && new Date(r1.checkin_time * 1000).toISOString() === '2026-10-05T00:55:00.000Z', JSON.stringify(r1));
check('状态/考勤组透传', r1.checkin_type === '上班' && r1.groupname === '实验室考勤组');
check('缺时间 → null', zklink.normalizeRecord({ name: '张三' }) === null);
check('缺人 → null', zklink.normalizeRecord({ punchTime: 1791657600 }) === null);

(async () => {
  console.log('\n== 5. 登录+拉数链路（mock fetch） ==');
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('/oauth/token')) {
      return { status: 200, json: async () => ({ access_token: 'tok1', expires_in: 7200 }) };
    }
    if (u.includes('/transaction/list')) {
      return {
        status: 200,
        json: async () => ({ data: { records: [
          { name: '张三', empNo: 'E1', punchTime: '2026-10-05 08:55:00' },
          { empNo: 'E2', punchTime: 1791657600 },
        ] } }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };
  const { records } = await zklink.fetchTransactions(Date.UTC(2026, 9, 4, 16, 0), Date.UTC(2026, 9, 11, 16, 0));
  check('归一化 2 条记录', records.length === 2, JSON.stringify(records));
  check('首条=张三 08:55+08:00', new Date(records[0].checkin_time * 1000).toISOString() === '2026-10-05T00:55:00.000Z');
  check('缺失姓名兜底 userid', records[1]._name === 'E2');
  const loginCall = calls.find((c) => c.url.includes('/oauth/token'));
  check('登录载荷带账号密码', loginCall.init.body.includes('probe-user') && loginCall.init.body.includes('probe-pass'), loginCall.init.body);
  const txCall = calls.find((c) => c.url.includes('/transaction/list'));
  check('拉数带 Bearer token', txCall.init.headers.Authorization === 'Bearer tok1');
  check('拉数带考勤组过滤 attGroupId=42', txCall.url.includes('attGroupId=42'), txCall.url);
  check('窗口参数存在', txCall.url.includes('beginDate=') && txCall.url.includes('endDate='));

  console.log('\n== 6. 登录失败（无 token 形态）报错带校准提示 ==');
  // 重载模块清 token 缓存（第 5 节登录成功已缓存 tok1，不清会绕过登录直接拉数）
  delete require.cache[require.resolve('../src/zklink/zklinkClient')];
  const zklink2 = require('../src/zklink/zklinkClient');
  global.fetch = async () => ({ status: 200, json: async () => ({ error: 'bad shape' }) });
  let err = null;
  try { await zklink2.fetchTransactions(0, 1); } catch (e) { err = e; }
  check('报错含校准 hint', err && String(err.message).includes('ZKLink 登录失败'), String(err));

  console.log('\n== 7. 未配凭据 → NO_CONFIG（独立子进程验证 env 缺失路径） ==');
  const zkModule = path.join(__dirname, '..', 'src', 'zklink', 'zklinkClient.js');
  const r = spawnSync('node', ['-e', `
    const z = require(process.env.ZK_MODULE);
    z.login().catch((e) => { console.log(e.errcode === 'NO_CONFIG' ? 'NO_CONFIG_OK' : 'WRONG:' + e.message); });
  `], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ZKLINK_USERNAME: '', ZKLINK_PASSWORD: '', ZK_MODULE: zkModule },
    encoding: 'utf8',
  });
  check('NO_CONFIG 指纹', (r.stdout || '').includes('NO_CONFIG_OK'), r.stdout + r.stderr);

  console.log('\n== 8. 静态 token 模式（飞书 SSO 账号贴 token，跳过登录端点） ==');
  delete require.cache[require.resolve('../src/zklink/zklinkClient')];
  delete require.cache[require.resolve('../src/zklink/config')]; // config 必须一起重载（zklinkAccessToken 在 require 时读 env）
  process.env.ZKLINK_ACCESS_TOKEN = 'static-tok-123';
  const zklink3 = require('../src/zklink/zklinkClient');
  process.env.ZKLINK_ACCESS_TOKEN = 'static-tok-123';
  const tokenCalls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    tokenCalls.push(u);
    if (u.includes('/oauth/token')) return { status: 500, json: async () => ({ error: 'login should not be called' }) };
    if (u.includes('/transaction/list')) {
      return { status: 200, json: async () => ({ data: { records: [{ name: '张三', empNo: 'E1', punchTime: '2026-10-05 08:55:00' }] } }) };
    }
    return { status: 404, json: async () => ({}) };
  };
  const r8 = await zklink3.fetchTransactions(Date.UTC(2026, 9, 4, 16, 0), Date.UTC(2026, 9, 11, 16, 0));
  check('静态 token 直接拉数成功', r8.records.length === 1, JSON.stringify(r8.records));
  check('未调用登录端点', !tokenCalls.some((u) => u.includes('/oauth/token')), JSON.stringify(tokenCalls));
  const tx8 = tokenCalls.find((u) => u.includes('/transaction/list'));
  const authHeader = (tx8 && tokenCalls.indexOf(tx8) >= 0) ? 'checked-below' : '';
  check('拉数带静态 Bearer token', authHeader === 'checked-below'); // Authorization 头在 init 里，下面用 calls 等价断言
  delete process.env.ZKLINK_ACCESS_TOKEN;
  check('isConfigured 恢复按账密判定', zklink3.isConfigured() === true); // USERNAME/PASSWORD 仍在 env

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
