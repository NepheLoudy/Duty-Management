// 三档及格线判定桩测试（2026-11-09 v71）：lineForGrade 三档取线 / passEnabled 门控 /
// loadGradeMap 花名册解析（open_id+姓名双映射、无档位跳过、分页、缓存）/ judgePass 判定与不判定分支。
// 全部出网（含 token）走 fetch 桩，不出网。运行：npm run test:pass-rule
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.ZKLINK_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-pass-rule-'));
process.env.APP_ID = 'test-app';
process.env.APP_SECRET = 'test-secret';

const config = require('../src/zklink/config');
const passRule = require('../src/zklink/passRule');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

const HOUR = 3600 * 1000;
const realFetch = global.fetch;

(async () => {
  console.log('\n== 1. lineForGrade / passEnabled 门控 ==');
  config.passRules = { core: 45, formal: 35, echelon: 20 };
  check('核心=45', passRule.lineForGrade('核心') === 45);
  check('正式=35', passRule.lineForGrade('正式') === 35);
  check('梯队=20', passRule.lineForGrade('梯队') === 20);
  check('未知档=0', passRule.lineForGrade('实习') === 0);
  config.gradeRosterWikiToken = 'wikitest';
  config.gradeRosterTableId = 'tbltest';
  check('配置齐全 → 启用', passRule.passEnabled() === true);
  config.gradeRosterTableId = '';
  check('缺表 id → 不启用', passRule.passEnabled() === false);
  config.gradeRosterTableId = 'tbltest';

  console.log('\n== 2. loadGradeMap：花名册解析（fetch 全桩） ==');
  let fetchCalls = 0;
  let recordsCall = 0;
  global.fetch = async (url) => {
    fetchCalls++;
    const u = String(url);
    const j = (code, data) => ({ json: async () => ({ code: code, data: data, msg: code === 0 ? 'success' : 'stub-err' }) });
    if (u.includes('/auth/v3/tenant_access_token/internal')) {
      return j(0, { tenant_access_token: 'stub-token' });
    }
    if (u.includes('/wiki/v2/spaces/get_node')) return j(0, { node: { obj_token: 'stub-app', obj_type: 'bitable' } });
    if (u.includes('/fields')) {
      return j(0, { items: [
        { field_name: '三级认定', type: 3 },
        { field_name: '人员', type: 11 },
        { field_name: '姓名', type: 1 },
        { field_name: '部门', type: 3 },
      ] });
    }
    if (u.includes('/records')) {
      recordsCall++;
      if (recordsCall === 1) {
        return j(0, { items: [
          { fields: { '三级认定': '核心', '人员': [{ id: 'ou_core' }], '姓名': '张三' } },
          { fields: { '三级认定': '梯队', '姓名': '王五' } }, // 无人员 open_id → 仅姓名映射
          { fields: { '姓名': '无档位' } }, // 无三级认定 → 跳过
          { fields: { '三级认定': '  正式  ', '人员': [{ id: 'ou_formal' }], '姓名': ' 李四 ' } }, // 带空白要 trim
        ], has_more: true, page_token: 'p2' });
      }
      return j(0, { items: [
        { fields: { '三级认定': '正式', '人员': [{ id: 'ou_f2' }], '姓名': '赵六' } },
      ], has_more: false });
    }
    return { json: async () => ({ code: 999, msg: 'unexpected url ' + u }) };
  };

  const gm = await passRule.loadGradeMap({ refresh: true });
  check('花名册档位行数=4（无档位行不计）', gm.count === 4, String(gm.count));
  check('open_id 映射：核心', gm.map.get('ou_core') === '核心');
  check('open_id 映射：正式(trim)', gm.map.get('ou_formal') === '正式');
  check('姓名映射兜底：王五=梯队', gm.byName.get('王五') === '梯队');
  check('姓名映射 trim：李四', gm.byName.get('李四') === '正式');
  check('分页拉齐：赵六', gm.byName.get('赵六') === '正式');
  const before = fetchCalls;
  await passRule.loadGradeMap();
  check('5 分钟内缓存生效（fetch 不再涨）', fetchCalls === before, before + '→' + fetchCalls);

  console.log('\n== 3. judgePass：判定与不判定分支 ==');
  check('核心 45h：达标 true', passRule.judgePass({ name: '张三', openId: 'ou_core', totalMs: 45 * HOUR }, gm) === null || (passRule.judgePass({ name: '张三', openId: 'ou_core', totalMs: 45 * HOUR }, gm).pass === true));
  const r1 = passRule.judgePass({ name: '张三', openId: 'ou_core', totalMs: 45 * HOUR }, gm);
  check('核心 45h 整：{grade=核心,line=45,pass=true}', r1 && r1.grade === '核心' && r1.lineHours === 45 && r1.pass === true, JSON.stringify(r1));
  const r2 = passRule.judgePass({ name: '张三', openId: 'ou_core', totalMs: 44 * HOUR + 59999 }, gm);
  check('核心 差 1 秒：false', r2 && r2.pass === false, JSON.stringify(r2));
  const r3 = passRule.judgePass({ name: '王五', totalMs: 20 * HOUR }, gm); // 无 openId 走姓名
  check('梯队 20h（姓名兜底）：true', r3 && r3.grade === '梯队' && r3.pass === true, JSON.stringify(r3));
  const r4 = passRule.judgePass({ name: '访客君', openId: 'ou_x', totalMs: 100 * HOUR }, gm);
  check('花名册外 → null（不判定）', r4 === null, JSON.stringify(r4));
  const r5 = passRule.judgePass({ name: '无档位', totalMs: 50 * HOUR }, gm);
  check('无档位 → null', r5 === null, JSON.stringify(r5));
  config.passRules = { core: 0, formal: 35, echelon: 20 };
  const r6 = passRule.judgePass({ name: '张三', openId: 'ou_core', totalMs: 50 * HOUR }, gm);
  check('该档线未配（core=0）→ null', r6 === null, JSON.stringify(r6));
  const r7 = passRule.judgePass({ name: '张三', openId: null, totalMs: 36 * HOUR }, gm); // openId 无 → 姓名「张三」…名字在但档位=核心线 0
  check('openId 缺+姓名命中但档位无线 → null', r7 === null, JSON.stringify(r7));
  config.passRules = { core: 45, formal: 35, echelon: 20 };
  const r8 = passRule.judgePass({ name: ' 李四 ', totalMs: 35 * HOUR }, gm);
  check('姓名 trim 匹配：正式 35h=true', r8 && r8.grade === '正式' && r8.pass === true, JSON.stringify(r8));
  check('judgePass(null map) 安全', passRule.judgePass({ name: '张三', totalMs: 1 }, null) === null);

  global.fetch = realFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
})().catch((e) => { global.fetch = realFetch; console.error('测试执行失败:', e); process.exit(1); });
