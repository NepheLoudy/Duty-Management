const config = require('../config');
const { addDays, diffDays, mondayOf, todayStr } = require('../utils/dates');
const algo = require('./scheduleAlgo');
const dutyTable = require('./dutyTableService');
const roster = require('./rosterService');
const state = require('./stateStore');
const bot = require('../feishu/bot');

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
  const pending = (s.obligations || []).filter((o) => !o.placed && !o.expired);
  if (pending.length === 0) return { placed, stillQueued, expired: [] };

  const all = await dutyTable.getAllDayRecords();

  // 目标周已完全过去的义务：就地插入只会造出「过去的脏班次」，标记过期留人工裁决
  const today = todayStr();
  const expired = pending.filter((o) => addDays(o.weekStart, 6) < today);
  if (!dryRun && expired.length > 0) {
    const expiredIds = new Set(expired.map((o) => o.id));
    state.mutate((st) => {
      for (const o of st.obligations) {
        if (expiredIds.has(o.id)) o.expired = true;
      }
    });
  }
  const active = pending.filter((o) => !expired.includes(o));

  // 周内排班快照：每次就地插入后同步更新，避免同人同周的第二条义务算出同一天（加罚双插）
  const assignments = new Map();
  for (const r of all) {
    if (!assignments.has(r.dateStr)) assignments.set(r.dateStr, []);
    assignments.get(r.dateStr).push({ name: r.name, position: r.position });
  }

  const placedIds = [];
  for (const o of active) {
    const weekEnd = addDays(o.weekStart, 6);
    const weekRecords = all.filter((r) => r.dateStr >= o.weekStart && r.dateStr <= weekEnd);
    if (weekRecords.length === 0) {
      stillQueued.push(o); // 下周还没生成，等生成排班表时优先安置
      continue;
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
      // 同步内存快照：同周后续义务（含加罚）不会重复落点
      if (!assignments.has(plan.dateStr)) assignments.set(plan.dateStr, []);
      assignments.get(plan.dateStr).push({ name: o.name, position: plan.position });
      placedIds.push({ id: o.id, plan });
    }
    placed.push({ ...o, plan });
  }

  // 义务标记按 id 定向 mutate，不整包回写旧快照（避免覆盖并发状态变更）
  if (!dryRun && placedIds.length > 0) {
    state.mutate((st) => {
      for (const o of st.obligations) {
        const m = placedIds.find((p) => p.id === o.id);
        if (m) {
          o.placed = true;
          o.placedAt = new Date().toISOString();
          o.placedDate = m.plan.dateStr;
          o.placedPosition = m.plan.position;
        }
      }
    });
  }

  return { placed, stillQueued, expired };
}

/**
 * 每日 00:30 对账：
 * 1) 补收口：错过 22:00 收口的日子（宕机/重启），把空状态置未做完 + 登记补偿 + 重算总状态
 *    （从上次收口日的次日起逐日回补，最多回看 7 天）；
 * 2) 以表格为准重算昨日总状态（兼容 admin 手工改表，有差异则同步写回）；
 * 3) 已做完成员连续缺勤计数清零；
 * 4) 补偿插入义务核对安置（目标周已过去的标记过期，留人工裁决）；
 * 5) 回执管理员。
 * @returns {{dayStatusChanged: boolean, yesterdayStatus, backfilled: Array, placed: Array, stillQueued: Array, expired: Array, report: string}}
 */
async function reconcile(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const today = todayStr();
  const yesterday = addDays(today, -1);

  // 1) 补收口：找出「有排班但没跑过收口」的日子
  const backfilled = [];
  const s = state.load();
  const lastClose = s.lastCloseDate || '';
  let from = lastClose ? addDays(lastClose, 1) : yesterday;
  if (diffDays(today, from) > 7) from = addDays(today, -7); // 多天宕机最多回看 7 天
  for (let d = from; d <= yesterday; d = addDays(d, 1)) {
    const recs = await dutyTable.getRecordsByDate(d);
    if (recs.length === 0) continue;
    const open = recs.filter((r) => !r.status);
    if (open.length === 0) continue; // 该日已收口（或手工改满），无需补

    if (!dryRun) {
      for (const r of open) {
        await dutyTable.setStatus(r.recordId, config.status.MISS);
      }
      // 总状态按补后口径重算
      const fresh = await dutyTable.getRecordsByDate(d);
      await dutyTable.setDayStatus(fresh.map((r) => r.recordId), dutyTable.computeDayStatus(fresh));
      for (const r of open) {
        if (r.name) handleAbsence(r.name, d, config.status.MISS);
      }
      // 清掉该日残留监听会话
      state.mutate((st) => {
        for (const [openId, session] of Object.entries(st.sessions)) {
          if (session.date === d) delete st.sessions[openId];
        }
      });
    }
    backfilled.push({ date: d, count: open.length, names: open.map((r) => r.name || '（未绑定）') });
  }
  if (!dryRun && (lastClose !== yesterday || backfilled.length > 0)) {
    state.mutate((st) => { st.lastCloseDate = yesterday; });
  }

  // 2) 重算昨日总状态（补收口后口径已是最新，这里只处理 admin 手工改表的差异）
  const recs = await dutyTable.getRecordsByDate(yesterday);
  const target = dutyTable.computeDayStatus(recs);
  const current = recs.map((r) => r.dayStatus).find(Boolean) || null;
  let dayStatusChanged = false;
  if (recs.length > 0 && target !== current && !dryRun) {
    await dutyTable.setDayStatus(recs.map((r) => r.recordId), target);
    dayStatusChanged = true;
  }

  // 3) 已完成值日的成员，连续缺勤计数清零
  if (!dryRun) {
    for (const r of recs) {
      if (r.status === config.status.DONE) resetStreak(r.name);
    }
  }

  // 4) 补偿义务安置
  const { placed, stillQueued, expired } = await placePending({ dryRun });

  const lines = [
    `🧹 值日对账（${yesterday}）`,
    `- 昨日总状态：${recs.length === 0 ? '无记录' : target || '未完成（保持为空）'}${dayStatusChanged ? '（已按表格实况修正）' : ''}`,
  ];
  for (const b of backfilled) {
    lines.push(`- ⚠️ 补收口 ${b.date}：${b.count} 人未确认已置未做完（${b.names.join('、')}），补偿义务已登记`);
  }
  lines.push(`- 补偿插入：本次安置 ${placed.length} 条，排队中 ${stillQueued.length} 条${expired.length ? `，过期标记 ${expired.length} 条（目标周已过去，请人工裁决）` : ''}`);
  for (const p of placed) {
    lines.push(`  · ${p.name} → ${p.plan.dateStr} ${p.plan.position}（${p.reason}）`);
  }

  const report = lines.join('\n');
  if (!dryRun && options.notify !== false) {
    for (const openId of roster.getAdminOpenIds()) {
      try {
        await bot.sendTextToUser(openId, report);
      } catch (err) {
        console.error('[对账] 管理员报告发送失败:', err.message);
      }
    }
  }

  return { dayStatusChanged, yesterdayStatus: target, backfilled, placed, stillQueued, expired, report };
}

module.exports = { handleAbsence, resetStreak, placePending, reconcile };
