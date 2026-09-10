const config = require('../config');
const { addDays, mondayOf, todayStr } = require('../utils/dates');
const algo = require('./scheduleAlgo');
const dutyTable = require('./dutyTableService');
const roster = require('./rosterService');
const state = require('./stateStore');

// ============================================================
// 缺勤补偿（可突破轮次上限）
// - 触发：当日记录被置「已请假」（请假当时）或「未做完」（22:00 收口时）
// - 动作：向该次值日所在自然周的下一周插入该队员 +1 次：
//   · 下周已生成 → 就地插入（空位日 + 当周岗位计数最少的岗位，该日变 4 人）
//   · 下周未生成 → 义务进 .duty-state.json 排队，生成排班表时优先安置
// - 加罚：同一人连续两次轮到自己没做完/请假 → 多加 1 次（该缺勤周期共 3 次）
// - 00:30 对账：核对下周插入义务是否全部安置，未安置补插
// ============================================================

function newId() {
  return `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 登记一次缺勤：连续计数 +1，生成下周插入义务；连续满 2 次触发加罚（+1）后计数清零。
 * @param {string} memberName
 * @param {string} dutyDateStr 缺勤那次值日的日期（义务插到其所在自然周的下一周）
 * @param {string} reason 已请假 / 未做完
 * @returns {{created: Array, penalty: boolean, streak: number}}
 */
function handleAbsence(memberName, dutyDateStr, reason) {
  const weekStart = addDays(mondayOf(dutyDateStr), 7);
  return state.mutate((s) => {
    const streak = s.absenceStreaks[memberName] || { count: 0, lastDate: '' };
    streak.count += 1;
    streak.lastDate = dutyDateStr;

    const created = [{
      id: newId(),
      name: memberName,
      weekStart,
      reason,
      placed: false,
      createdAt: new Date().toISOString(),
    }];
    let penalty = false;
    if (streak.count >= 2) {
      created.push({
        id: newId(),
        name: memberName,
        weekStart,
        reason: `${reason}（连续两次缺勤加罚）`,
        placed: false,
        createdAt: new Date().toISOString(),
      });
      penalty = true;
      streak.count = 0;
    }
    s.absenceStreaks[memberName] = streak;
    s.obligations.push(...created);
    return { created, penalty, streak: streak.count };
  });
}

/** 完成 1 次值日（回「是」/ 对账发现已做完）→ 连续缺勤计数清零 */
function resetStreak(memberName) {
  state.mutate((s) => {
    if (s.absenceStreaks[memberName]) {
      s.absenceStreaks[memberName] = { count: 0, lastDate: '' };
    }
  });
}

/**
 * 尝试就地安置未安置的义务：目标周已有排班 → 插入；目标周还没生成 → 留队。
 * @returns {{placed: Array, stillQueued: Array}}
 */
async function placePending(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const placed = [];
  const stillQueued = [];

  const s = state.load();
  const pending = (s.obligations || []).filter((o) => !o.placed);
  if (pending.length === 0) return { placed, stillQueued };

  const all = await dutyTable.getAllDayRecords();

  for (const o of pending) {
    const weekEnd = addDays(o.weekStart, 6);
    const weekRecords = all.filter((r) => r.dateStr >= o.weekStart && r.dateStr <= weekEnd);
    if (weekRecords.length === 0) {
      stillQueued.push(o); // 下周还没生成，等生成排班表时优先安置
      continue;
    }
    const assignments = new Map();
    for (const r of weekRecords) {
      if (!assignments.has(r.dateStr)) assignments.set(r.dateStr, []);
      assignments.get(r.dateStr).push({ name: r.name, position: r.position });
    }
    const plan = algo.planInsertion({
      weekStartStr: o.weekStart,
      rangeStart: o.weekStart,
      rangeEnd: weekEnd,
      memberName: o.name,
      assignments,
    });
    if (!plan) {
      stillQueued.push(o); // 周内天天都有该队员（极小队），留队下次再试
      continue;
    }
    if (!dryRun) {
      const member = roster.findByName(o.name) || { name: o.name };
      await dutyTable.createDayRecords(plan.dateStr, [{ member, position: plan.position }]);
      o.placed = true;
      o.placedAt = new Date().toISOString();
      o.placedDate = plan.dateStr;
      o.placedPosition = plan.position;
      state.save(s);
    }
    placed.push({ ...o, plan });
  }

  return { placed, stillQueued };
}

/**
 * 每日 00:30 对账：
 * 1) 以表格为准重算前一日总状态（兼容 admin 手工改表，有差异则同步写回）；
 * 2) 前一日已做完的成员连续缺勤计数清零；
 * 3) 补偿插入义务核对安置；
 * @returns {{dayStatusChanged: boolean, yesterdayStatus, placed: Array, stillQueued: Array, report: string}}
 */
async function reconcile(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const yesterday = addDays(todayStr(), -1);

  // 1) 重算昨日总状态
  const recs = await dutyTable.getRecordsByDate(yesterday);
  const target = dutyTable.computeDayStatus(recs);
  const current = recs.map((r) => r.dayStatus).find(Boolean) || null;
  let dayStatusChanged = false;
  if (recs.length > 0 && target !== current && !dryRun) {
    await dutyTable.setDayStatus(recs.map((r) => r.recordId), target);
    dayStatusChanged = true;
  }

  // 2) 昨日已完成值日的成员，连续缺勤计数清零
  if (!dryRun) {
    for (const r of recs) {
      if (r.status === config.status.DONE) resetStreak(r.name);
    }
  }

  // 3) 补偿义务安置
  const { placed, stillQueued } = await placePending({ dryRun });

  const lines = [
    `🧹 值日对账（${yesterday}）`,
    `- 昨日总状态：${recs.length === 0 ? '无记录' : target || '未完成（保持为空）'}${dayStatusChanged ? '（已按表格实况修正）' : ''}`,
    `- 补偿插入：本次安置 ${placed.length} 条，排队中 ${stillQueued.length} 条`,
  ];
  for (const p of placed) {
    lines.push(`  · ${p.name} → ${p.plan.dateStr} ${p.plan.position}（${p.reason}）`);
  }

  return { dayStatusChanged, yesterdayStatus: target, placed, stillQueued, report: lines.join('\n') };
}

module.exports = { handleAbsence, resetStreak, placePending, reconcile };
