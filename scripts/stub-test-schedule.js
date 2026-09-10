/**
 * M1 排班引擎单测（纯函数，不触网、不读表格）
 * 覆盖：不重不漏、岗位配额、间隔软约束、插入安置（4 人日/岗位均匀）、配额跨批次衔接。
 * 运行：npm run test:schedule
 */
const algo = require('../src/services/scheduleAlgo');
const { addDays } = require('../src/utils/dates');

let failed = 0;
function check(desc, cond, detail = '') {
  if (cond) {
    console.log(`✓ ${desc}`);
  } else {
    failed += 1;
    console.error(`❌ ${desc}${detail ? ` —— ${detail}` : ''}`);
  }
}

function fixtureMembers(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `队员${String.fromCharCode(65 + i)}`, openId: `ou_test_${i}` }));
}

function flatten(result) {
  const byDate = new Map();
  const shifts = [];
  for (const day of result.days) {
    byDate.set(day.date, day.items);
    for (const it of day.items) shifts.push({ ...it, date: day.date });
  }
  return { byDate, shifts };
}

// ---------- 用例 1：8 人从空表生成 30 天 ----------
{
  const members = fixtureMembers(8);
  const start = '2026-10-01';
  const result = algo.generateSchedule({ members, startDateStr: start, days: 30, history: [], insertions: [], seedStr: 't1' });
  const { byDate, shifts } = flatten(result);

  check('用例1 生成天数覆盖', result.days.length === 30, `实际 ${result.days.length}`);

  const dupDay = [...byDate.values()].some((items) => new Set(items.map((i) => i.name)).size !== items.length);
  check('用例1 同一天人员不重复', !dupDay);

  const dayCounts = [...byDate.values()].map((i) => i.length);
  check('用例1 每天都满 3 人（配额 1/1/1 与日构成自洽，无缺口日）', dayCounts.every((c) => c === 3), JSON.stringify(dayCounts.filter((c) => c !== 3)));

  // 完整轮校验：每人每轮 3 次 = 三岗各 1；轮内未完成部分每岗不超过 1
  const counts = new Map(members.map((m) => [m.name, { '总负责': 0, '工位区': 0, '装配区': 0, total: 0 }]));
  for (const s of shifts) {
    const c = counts.get(s.name);
    if (!c) continue;
    c[s.position] += 1;
    c.total += 1;
  }
  let roundOk = true;
  for (const [name, c] of counts) {
    if (c.total < 3) continue;
    const rounds = Math.floor(c.total / 3);
    for (const pos of ['总负责', '工位区', '装配区']) {
      if (c[pos] < rounds || c[pos] > rounds + 1) roundOk = false;
    }
  }
  check('用例1 岗位配额精确贴合轮次（完整轮三岗各 1，轮内不越界）', roundOk);

  // 间隔软约束：统计违反 ≥2 天间隔的比例（应很低，人少时允许放宽）
  const lastMap = new Map();
  let violations = 0;
  for (const s of shifts.sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const last = lastMap.get(s.name);
    if (last) {
      const diff = Math.round((new Date(s.date) - new Date(last)) / 86400000);
      if (diff < 2) violations += 1;
    }
    lastMap.set(s.name, s.date);
  }
  check('用例1 间隔 <2 天的班次占比 <15%（软约束）', violations / shifts.length < 0.15, `违反 ${violations}/${shifts.length}`);

  // 每天人数不超过 3，人员互不重复；每天三岗位各一人
  let dayOk = true;
  for (const [, items] of byDate) {
    if (items.length > 3 || new Set(items.map((i) => i.name)).size !== items.length) dayOk = false;
    if (new Set(items.map((i) => i.position)).size !== items.length) dayOk = false;
  }
  check('用例1 每天人数 ≤3 且三岗位各一人', dayOk);
}

// ---------- 用例 2：配额跨批次衔接（历史已做部分轮次） ----------
{
  const members = fixtureMembers(6);
  const history = [];
  // 队员A 本轮已做 总负责×1 + 工位×1（剩装配×1）；队员B 已做 总负责×1（剩 工位/装配）
  history.push({ name: '队员A', position: '总负责', date: '2026-09-01' });
  history.push({ name: '队员A', position: '工位区', date: '2026-09-04' });
  history.push({ name: '队员B', position: '总负责', date: '2026-09-10' });

  const quotas = algo.computeRemainingQuotas(members, history);
  const qa = quotas.get('队员A');
  check('用例2 队员A 剩余配额 = 装配×1（本轮）', qa.remaining['装配区'] === 1 && qa.remaining['总负责'] === 0 && qa.remaining['工位区'] === 0 && qa.remainingTotal === 1,
    JSON.stringify(qa));
  const qb = quotas.get('队员B');
  check('用例2 队员B 剩余配额 = 工位×1/装配×1', qb.remaining['总负责'] === 0 && qb.remaining['工位区'] === 1 && qb.remaining['装配区'] === 1,
    JSON.stringify(qb));

  // 生成期延续：队员A 在生成期内先被排的岗位不应是总负责（本轮已满）
  const result = algo.generateSchedule({
    members, startDateStr: '2026-10-01', days: 14, history, insertions: [], seedStr: 't2',
  });
  const aFirst = flatten(result).shifts.filter((s) => s.name === '队员A').sort((x, y) => (x.date < y.date ? -1 : 1))[0];
  check('用例2 队员A 首个新班次优先补装配区', aFirst && aFirst.position === '装配区', aFirst && JSON.stringify(aFirst));
}

// ---------- 用例 3：插入安置（下周已生成 → 4 人日 + 岗位均匀） ----------
{
  const members = fixtureMembers(8);
  const start = '2026-10-05'; // 周一
  const insertions = [
    { name: '队员A', weekStartStr: start },
    { name: '队员A', weekStartStr: start },
  ];
  const result = algo.generateSchedule({ members, startDateStr: start, days: 28, history: [], insertions, seedStr: 't3' });
  const { byDate } = flatten(result);

  const fourDays = [...byDate.entries()].filter(([, items]) => items.length === 4);
  check('用例3 出现 4 人插入日', fourDays.length >= 1);

  // 4 人日里插入者所在岗位应有两人（岗位允许重复）
  let insertOk = true;
  for (const [, items] of fourDays) {
    const posCount = {};
    for (const it of items) posCount[it.position] = (posCount[it.position] || 0) + 1;
    if (!Object.values(posCount).some((c) => c >= 2)) insertOk = false;
  }
  check('用例3 插入日出现同岗两人（突破上限）', insertOk);

  // 两次插入应尽量落在不同岗位（当周岗位计数最少优先）
  const aIns = [];
  for (const [, items] of byDate) {
    for (const it of items) if (it.name === '队员A' && it.isInsertion) aIns.push(it.position);
  }
  check('用例3 队员A 两次插入岗位分散', aIns.length === 2 && aIns[0] !== aIns[1], JSON.stringify(aIns));
}

// ---------- 用例 4：插入日避开本人已有班次 ----------
{
  const members = fixtureMembers(4);
  const start = '2026-10-05';
  const insertions = [{ name: '队员A', weekStartStr: start }];
  const result = algo.generateSchedule({ members, startDateStr: start, days: 7, history: [], insertions, seedStr: 't4' });
  const { byDate } = flatten(result);
  let overlap = false;
  for (const [, items] of byDate) {
    const names = items.map((i) => i.name);
    if (names.filter((n) => n === '队员A').length > 1) overlap = true;
  }
  check('用例4 插入不与本人同日班次重叠', !overlap);

  // 4 人小队：每天 3 人不重不漏仍成立
  let dup = false;
  for (const [, items] of byDate) {
    if (new Set(items.map((i) => i.name)).size !== items.length) dup = true;
  }
  check('用例4 小队同日仍不重不漏', !dup);
}

// ---------- 用例 5：同参数可复现 ----------
{
  const members = fixtureMembers(8);
  const a = algo.generateSchedule({ members, startDateStr: '2026-10-01', days: 14, history: [], insertions: [], seedStr: 'same' });
  const b = algo.generateSchedule({ members, startDateStr: '2026-10-01', days: 14, history: [], insertions: [], seedStr: 'same' });
  check('用例5 同种子结果一致', JSON.stringify(a.days) === JSON.stringify(b.days));
}

// ---------- 用例 6：planInsertion 选空位日与最少岗位 ----------
{
  const assignments = new Map([
    ['2026-10-05', [{ name: '队员B', position: '总负责' }, { name: '队员C', position: '工位区' }, { name: '队员D', position: '装配区' }]],
    ['2026-10-06', [{ name: '队员B', position: '总负责' }, { name: '队员C', position: '工位区' }, { name: '队员D', position: '装配区' }]],
    ['2026-10-07', [{ name: '队员C', position: '工位区' }, { name: '队员D', position: '装配区' }, { name: '队员A', position: '工位区' }]],
  ]);
  // 当周岗位计数：总负责 2 / 工位区 4 / 装配区 3 → 插入应取「总负责」
  const plan = algo.planInsertion({
    weekStartStr: '2026-10-05', rangeStart: '2026-10-05', rangeEnd: '2026-10-11',
    memberName: '队员A', assignments,
  });
  check('用例6 队员A 避开已有班次日（10-05/06/07）', plan && !['2026-10-05', '2026-10-06', '2026-10-07'].includes(plan.dateStr), plan && JSON.stringify(plan));
  check('用例6 岗位取当周计数最少（总负责）', plan && plan.position === '总负责', plan && JSON.stringify(plan));
  // 空位日 10-08~10-11 人手同为 0，按人名散列在并列日中取（确定性可复现）
  const expectedDate = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'][algo.hashSeed('队员A') % 4];
  check(`用例6 日期在并列空位日中按散列取（${expectedDate}）`, plan && plan.dateStr === expectedDate, plan && JSON.stringify(plan));
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
