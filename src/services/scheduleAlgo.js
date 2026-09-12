const { addDays, diffDays } = require('../utils/dates');

// ============================================================
// 排班算法（纯函数，无 IO —— 可被 stub 单测直接验证）
//
// 轮转规则：每人每轮 3 次值日 = 总负责/工位区/装配区 各 1 次。
// 轮转状态不单独维护：每次生成时由「本轮开始前的既有记录」反推每人剩余配额
// （computeRemainingQuotas），单一事实来源在多维表格。
//
// 配额 1/1/1 与「每天三岗位各一人」自洽：一轮恰好 N 天（N=队列人数），
// 每日岗位构成严格一岗一人，无需同岗两人弹性（缺勤插入除外）。
//
// 约束（按优先级）：
//   1. 同一天 base 岗位 3 人互不相同，且三岗位各一人；
//   2. 岗位配额精确（每人每轮三岗各 1）；
//   3. 同一人两次值日间隔 ≥ minIntervalDays（软约束，候选不足时逐级放宽）；
//   4. 岗位分配顺序按日期轮换，避免某人固定同一岗位/同一星期几。
// 实现为配额贪心 + 受限随机（带种子，同参数可复现，便于调试）。
//
// 缺勤补偿插入可突破轮次上限：插入日变成 4 人（一岗位两人）；
// 插入日优先于常规轮转安置，岗位取当周各岗位计数最少的。
// ============================================================

const POSITIONS = ['总负责', '工位区', '装配区'];
const ROUND_TARGET = { '总负责': 1, '工位区': 1, '装配区': 1 };
const ROUND_TOTAL = 3;

// ---------- 可复现随机 ----------

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 配额反推 ----------

/**
 * 由既有记录反推每人本轮剩余配额。
 * @param {Array<{name: string}>} members 值日队列成员
 * @param {Array<{name: string, position: string}>} history 本轮开始前的既有班次
 * @returns {Map<name, {remaining: Object<position, number>, remainingTotal: number, doneTotal: number}>}
 */
function computeRemainingQuotas(members, history) {
  const done = new Map();
  for (const m of members) {
    done.set(m.name, { '总负责': 0, '工位区': 0, '装配区': 0, total: 0 });
  }
  for (const h of history) {
    const d = done.get(h.name);
    if (!d || !ROUND_TARGET[h.position]) continue;
    d[h.position] += 1;
    d.total += 1;
  }

  const result = new Map();
  for (const m of members) {
    const d = done.get(m.name);
    const completeRounds = Math.floor(d.total / ROUND_TOTAL);
    const remaining = {};
    let remainingTotal = 0;
    for (const pos of POSITIONS) {
      // 本轮该岗位已做 = 累计 - 完整轮数×目标（夹到 [0, 目标]，容忍插入突破造成的溢出）
      const cur = Math.min(ROUND_TARGET[pos], Math.max(0, d[pos] - completeRounds * ROUND_TARGET[pos]));
      remaining[pos] = ROUND_TARGET[pos] - cur;
      remainingTotal += remaining[pos];
    }
    result.set(m.name, { remaining, remainingTotal, doneTotal: d.total });
  }
  return result;
}

// ---------- 插入安置（单次，纯函数） ----------

/**
 * 为一次补偿插入找安置点：目标周内该队员没有班次的「空位日」，
 * 岗位取当周各岗位计数最少的（保证插人后三岗位尽量均匀）；
 * 多个候选日取人最少的那天（摊薄负载），同人数取最早。
 * @param {object} p
 * @param {string} p.weekStartStr 目标自然周周一（自然周周一~周日）
 * @param {string} p.rangeStart 生成范围起点（可为周内）
 * @param {string} p.rangeEnd 生成范围终点（可为周内）
 * @param {string} p.memberName
 * @param {Map<string, Array<{name: string, position: string}>>} p.assignments 已排（含常规与其它插入）
 * @returns {{dateStr: string, position: string}|null}
 */
function planInsertion({ weekStartStr, rangeStart, rangeEnd, memberName, assignments }) {
  const first = weekStartStr > rangeStart ? weekStartStr : rangeStart;
  const last = addDays(weekStartStr, 6) < rangeEnd ? addDays(weekStartStr, 6) : rangeEnd;
  if (first > last) return null;

  // 岗位计数覆盖整周（含本人已有班次日），保证插入后三岗位尽量均匀
  const posCount = { '总负责': 0, '工位区': 0, '装配区': 0 };
  const candidates = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const items = assignments.get(d) || [];
    for (const it of items) posCount[it.position] += 1;
    if (items.some((it) => it.name === memberName)) continue; // 该日已有班次，跳过
    candidates.push({ dateStr: d, people: items.length });
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.people - b.people || (a.dateStr < b.dateStr ? -1 : 1));
  // 人最少的候选日里按人名散列错开，避免同周多个插入扎堆同一天（保持确定性可复现）
  const minPeople = candidates[0].people;
  const ties = candidates.filter((c) => c.people === minPeople);
  const dateStr = ties[hashSeed(memberName) % ties.length].dateStr;
  const position = POSITIONS.reduce((best, pos) => (posCount[pos] < posCount[best] ? pos : best), POSITIONS[0]);
  return { dateStr, position };
}

// ---------- 常规排班生成 ----------

/**
 * 生成一段排班。
 * @param {object} p
 * @param {Array<{name: string, openId?: string}>} p.members 值日队列
 * @param {string} p.startDateStr 起始日（含）
 * @param {number} p.days 生成天数
 * @param {Array<{name: string, position: string, date: string}>} p.history 起始日之前的既有班次（反推配额与间隔）
 * @param {Array<{name: string, weekStartStr: string}>} p.insertions 需优先安置的补偿插入（每条=1次）
 * @param {number} p.minIntervalDays 同一人两次值日最小间隔（软约束）
 * @param {string} p.seedStr 随机种子（同参数可复现）
 * @returns {{days: Array<{date: string, items: Array<{name: string, position: string, isInsertion: boolean}>}>, unplacedInsertions: Array, quotaReport: Array}}
 */
function generateSchedule({ members, startDateStr, days, history = [], insertions = [], minIntervalDays = 2, seedStr = 'duty' }) {
  const rng = mulberry32(hashSeed(seedStr));
  const assignments = new Map(); // dateStr -> [{name, position, isInsertion}]
  const unplacedInsertions = [];

  const quotas = computeRemainingQuotas(members, history);
  const lastDuty = new Map(); // name -> 最近一次值日日期串（含历史与本次生成）
  for (const h of history) {
    const prev = lastDuty.get(h.name);
    if (!prev || h.date > prev) lastDuty.set(h.name, h.date);
  }

  const getItems = (date) => {
    if (!assignments.has(date)) assignments.set(date, []);
    return assignments.get(date);
  };

  const hasDutyOn = (name, date) => (assignments.get(date) || []).some((it) => it.name === name);

  // -- 1) 补偿插入优先安置（可突破轮次上限，该日变成 4 人） --
  for (const ins of insertions) {
    if (!quotas.has(ins.name)) {
      // 不在值日队列（如白名单成员）：补偿义务不豁免，进未安置队列留
      // placePending 兜底安置（00:30 对账），并随生成回执上报
      unplacedInsertions.push(ins);
      continue;
    }
    const plan = planInsertion({
      weekStartStr: ins.weekStartStr,
      rangeStart: startDateStr,
      rangeEnd: addDays(startDateStr, days - 1),
      memberName: ins.name,
      assignments,
    });
    if (!plan) {
      unplacedInsertions.push(ins);
      continue;
    }
    getItems(plan.dateStr).push({ name: ins.name, position: plan.position, isInsertion: true });
    lastDuty.set(ins.name, plan.dateStr); // 插入也是一次值日，影响间隔约束
  }

  // -- 2) 逐日补满 base 3 班次：每天三岗位各一人 --
  // 按天做联合最优分配：从当日候选池枚举「三人组合 × 三岗全排列」，整体打分
  // 挑配额满足度最高的方案（欠什么岗上什么岗；错配日把偏离最小化），
  // 岗位基准顺序按日期轮换避免固定同人同岗；同分受限随机，同参数可复现。
  const chooseDayAssignment = (pool, dayIndex) => {
    const order = POSITIONS.map((_, k) => POSITIONS[(k + dayIndex) % 3]);
    const n = Math.min(3, pool.length);
    let best = null;
    let bestScore = -Infinity;

    // 保序枚举 n 人组合
    const combos = [];
    const rec = (start, acc) => {
      if (acc.length === n) { combos.push([...acc]); return; }
      for (let i = start; i < pool.length; i++) rec(i + 1, [...acc, pool[i]]);
    };
    rec(0, []);

    for (const combo of combos) {
      const permute = (arr, locked) => {
        if (arr.length === 0) {
          let score = 0;
          for (const [pos, m] of locked) {
            const q = quotas.get(m.name);
            // 配额满足绝对优先；被迫错配时交给剩余配额最少的人（离轮末最近）
            score += q.remaining[pos] > 0 ? 1000 + q.remaining[pos] * 100 : -1000 + q.remainingTotal;
          }
          score += rng() * 0.5; // 同分受限随机
          if (score > bestScore) { bestScore = score; best = locked.map(([pos, m]) => ({ name: m.name, position: pos })); }
          return;
        }
        for (let k = 0; k < arr.length; k++) {
          permute([...arr.slice(0, k), ...arr.slice(k + 1)], [...locked, [order[locked.length], arr[k]]]);
        }
      };
      permute(combo, []);
    }
    return best || [];
  };

  for (let i = 0; i < days; i++) {
    const date = addDays(startDateStr, i);
    const existing = getItems(date);

    // 当日候选：间隔软约束逐级放宽（人少时放宽），同日不重复
    let eligible = [];
    for (let interval = minIntervalDays; interval >= 0; interval--) {
      eligible = members.filter((m) => {
        if (hasDutyOn(m.name, date)) return false;
        const last = lastDuty.get(m.name);
        if (last && diffDays(date, last) <= interval) return false;
        return true;
      });
      if (eligible.length >= 3 || interval === 0) break;
    }
    if (eligible.length === 0) continue;

    // 个别成员本轮配额已尽：仅让这些人提前进入下一轮（缺口即时衔接，天不缺员）
    let pool = eligible.filter((m) => quotas.get(m.name).remainingTotal > 0);
    if (pool.length < Math.min(3, eligible.length)) {
      for (const m of members) {
        const q = quotas.get(m.name);
        if (q.remainingTotal === 0) {
          q.remaining = { '总负责': ROUND_TARGET['总负责'], '工位区': ROUND_TARGET['工位区'], '装配区': ROUND_TARGET['装配区'] };
          q.remainingTotal = ROUND_TOTAL;
        }
      }
      pool = eligible;
    }

    const chosen = chooseDayAssignment(pool, i);
    for (const c of chosen) {
      const q = quotas.get(c.name);
      if (q.remaining[c.position] > 0) { q.remaining[c.position] -= 1; q.remainingTotal -= 1; }
      existing.push(c);
      lastDuty.set(c.name, date);
    }
  }

  const days_ = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(startDateStr, i);
    const items = assignments.get(date) || [];
    if (items.length > 0) days_.push({ date, items });
  }

  const quotaReport = members.map((m) => {
    const counts = { '总负责': 0, '工位区': 0, '装配区': 0 };
    let total = 0;
    for (const { items } of days_) {
      for (const it of items) {
        if (it.name === m.name) { counts[it.position] += 1; total += 1; }
      }
    }
    return { name: m.name, counts, total };
  });

  return { days: days_, unplacedInsertions, quotaReport };
}

module.exports = {
  POSITIONS,
  ROUND_TARGET,
  ROUND_TOTAL,
  hashSeed,
  mulberry32,
  computeRemainingQuotas,
  planInsertion,
  generateSchedule,
};
