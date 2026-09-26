const config = require('../config');
const { addDays, diffDays, mondayOf, todayStr } = require('../utils/dates');
const algo = require('./scheduleAlgo');
const dutyTable = require('./dutyTableService');
const roster = require('./rosterService');
const state = require('./stateStore');
const bot = require('../feishu/bot');
const { withScheduleLock } = require('./scheduleService');

// ============================================================
// 缺勤补偿（可突破轮次上限）
// - 触发：当日记录被置「已请假」（请假当时）或「未做完」（24:00 收口时）
// - 动作：向该次值日所在自然周的下一周插入该队员 +1 次：
//   · 下周已生成 → 就地插入（空位日 + 当周岗位计数最少的岗位，该日变 4 人）
//   · 下周未生成 → 义务进 .duty-state.json 排队，生成排班表时优先安置
//   · 下周已生成但该队员当周天天有班（小队多条补偿同周）→ 顺延到再下一周
//     （weekStart+7、deferCount 计数，对账报告可见；不再静默留队到过期）
// - 加罚（2026-09-24 收紧口径）：同一人连续两次「未做完」→ 多加 1 次（该缺勤周期共 3 次）；
//   主动请假不计入连续缺勤（合规安排不同罪，防止请假→加罚→班更多→更易被抽调的雪球）
// - 00:30 对账：核对下周插入义务是否全部安置，未安置补插或顺延
// ============================================================

function newId() {
  return `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 登记一次缺勤：生成下周插入义务。
 * 加罚只计「未做完」（2026-09-24）：主动请假属合规安排（可提前查班、请假当日由同日
 * 队员兼顾、补偿总量守恒），不计入连续缺勤——否则一次请假翻倍成两次补偿，惩罚滚雪球
 * （叠加补位抽调后会反复选中同一人）。连续两次「未做完」仍触发加罚（+1）后计数清零。
 * @param {string} memberName
 * @param {string} dutyDateStr 缺勤那次值日的日期（义务插到其所在自然周的下一周）
 * @param {string} reason 已请假 / 未做完
 * @returns {{created: Array, penalty: boolean, streak: number}}
 */
function handleAbsence(memberName, dutyDateStr, reason) {
  const weekStart = addDays(mondayOf(dutyDateStr), 7);
  return state.mutate((s) => {
    const created = [{
      id: newId(),
      name: memberName,
      dutyDate: dutyDateStr,
      weekStart,
      reason,
      placed: false,
      createdAt: new Date().toISOString(),
    }];
    let penalty = false;
    if (reason === config.status.MISS) {
      const streak = s.absenceStreaks[memberName] || { count: 0, lastDate: '' };
      streak.count += 1;
      streak.lastDate = dutyDateStr;
      if (streak.count >= 2) {
        created.push({
          id: newId(),
          name: memberName,
          dutyDate: dutyDateStr,
          weekStart,
          reason: `${reason}（连续两次缺勤加罚）`,
          placed: false,
          createdAt: new Date().toISOString(),
        });
        penalty = true;
        streak.count = 0;
      }
      s.absenceStreaks[memberName] = streak;
    }
    s.obligations.push(...created);
    return { created, penalty, streak: (s.absenceStreaks[memberName] || { count: 0 }).count };
  });
}

/**
 * 缺勤补偿同步：把「已请假 / 未做完」两类记录都补进下周插入队列。
 * 覆盖所有来源——私信请假/收口置未做完（当时已登记，按 姓名+值日日期+原因 去重跳过）、
 * 管理员在表格里手工标记的状态（此前不会登记补偿，这里补上）。
 * @param {string} dutyDateStr 值日日期
 * @param {Array<{name: string, status: string}>} records 该日记录（归一化结构）
 * @returns {number} 新登记的义务条数
 */
function syncAbsenceObligations(dutyDateStr, records) {
  const weekStart = addDays(mondayOf(dutyDateStr), 7);
  const absent = records.filter(
    (r) => r.name && (r.status === config.status.LEAVE || r.status === config.status.MISS)
  );
  if (absent.length === 0) return 0;

  return state.mutate((s) => {
    let created = 0;
    for (const rec of absent) {
      const exists = (s.obligations || []).some(
        // 旧版义务没有 dutyDate 字段：按 姓名+原因 宽松匹配，避免重复登记
        (o) => o.name === rec.name && (o.dutyDate === undefined || o.dutyDate === dutyDateStr) && o.reason.startsWith(rec.status)
      );
      if (exists) continue;
      s.obligations.push({
        id: newId(),
        name: rec.name,
        dutyDate: dutyDateStr,
        weekStart,
        reason: rec.status,
        placed: false,
        createdAt: new Date().toISOString(),
      });
      created += 1;
    }
    return created;
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
 * 尝试就地安置未安置的义务：目标周已有排班 → 插入；目标周还没生成 → 留队；
 * 目标周已生成但该队员周内天天有班 → 顺延下一周（2026-09-19，小队满周退化路径）。
 * 排班写链路全局串行（2026-09-27）：与 generate/rebalance 共用 withScheduleLock，
 * 生成刚落表的对账安置不会与管理员手工触发的生成交叉读改写。
 * @returns {{placed: Array, stillQueued: Array, deferred: Array, expired: Array}}
 */
async function placePending(options = {}) {
  return withScheduleLock(() => placePendingLocked(options));
}

async function placePendingLocked(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const placed = [];
  const stillQueued = [];
  const deferred = [];

  const s = state.load();
  const pending = (s.obligations || []).filter((o) => !o.placed && !o.expired);
  if (pending.length === 0) return { placed, stillQueued, deferred, expired: [] };

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

  // 周内排班快照：每次就地插入后同步更新，避免同人同周的第二条义务算出同一天（加罚双插）。
  // status 带上记录状态，供 planInsertion 判定「请假空缺位」（2026-09-25 检修口径）
  const assignments = new Map();
  for (const r of all) {
    if (!assignments.has(r.dateStr)) assignments.set(r.dateStr, []);
    assignments.get(r.dateStr).push({ name: r.name, position: r.position, status: r.status });
  }

  // 周级插入容量（2026-09-25）：非请假位插入每周最多 weeklyInsertionAllowance 条，
  // 超出顺延下一周——防止欠账集中安置把一周插成天天 4 人。填请假位不占容量。
  const allowance = Number(config.generate?.weeklyInsertionAllowance) || 2;
  const weeklyInserted = new Map(); // weekStart -> 已用非请假位插入数

  const placedIds = [];
  for (const o of active) {
    const weekEnd = addDays(o.weekStart, 6);
    const weekRecords = all.filter((r) => r.dateStr >= o.weekStart && r.dateStr <= weekEnd);
    if (weekRecords.length === 0) {
      stillQueued.push(o); // 下周还没生成，等生成排班表时优先安置
      continue;
    }
    // rangeStart 不早于今天（2026-09-13）：目标周部分已过时（宕机恢复/写表失败重试），
    // planInsertion 的并列候选含已过去的日子且按人名散列任选——会造出过去的脏班次
    const rangeStart = o.weekStart < today ? today : o.weekStart;
    const plan = algo.planInsertion({
      weekStartStr: o.weekStart,
      rangeStart,
      rangeEnd: weekEnd,
      memberName: o.name,
      assignments,
    });
    if (!plan) {
      // 周内天天都有该队员（极小队多条补偿同周）：顺延到下一周再试——
      // 新周未生成时下轮自然转回「留队等生成」分支，不会死循环占座
      const nextWeekStart = addDays(o.weekStart, 7);
      if (!dryRun) {
        state.mutate((st) => {
          for (const o2 of st.obligations) {
            if (o2.id === o.id) {
              o2.weekStart = nextWeekStart;
              o2.deferCount = (o2.deferCount || 0) + 1;
              delete o2.deferReason; // 满周顺延清掉旧的容量顺延标记，防持久化层脏读
            }
          }
        });
      }
      // 显式携带 deferCount/deferReason：mutate 是「读盘-改-写盘」语义，o 与写盘副本
      // 不共享引用，spread 不会带上 mutate 里的设置（v39 复查修复）
      deferred.push({ ...o, weekStart: nextWeekStart, deferCount: (o.deferCount || 0) + 1, deferReason: '' });
      continue;
    }
    // 周容量闸门（非请假位）：本周插入额度用尽 → 顺延下一周
    if (!plan.fillLeave && (weeklyInserted.get(o.weekStart) || 0) >= allowance) {
      const nextWeekStart = addDays(o.weekStart, 7);
      if (!dryRun) {
        state.mutate((st) => {
          for (const o2 of st.obligations) {
            if (o2.id === o.id) {
              o2.weekStart = nextWeekStart;
              o2.deferCount = (o2.deferCount || 0) + 1;
              o2.deferReason = 'weekly_allowance';
            }
          }
        });
      }
      deferred.push({ ...o, weekStart: nextWeekStart, deferCount: (o.deferCount || 0) + 1, deferReason: 'weekly_allowance' });
      continue;
    }
    if (!dryRun) {
      const member = roster.findByName(o.name) || { name: o.name };
      await dutyTable.createDayRecords(plan.dateStr, [{ member, position: plan.position }]);
      // 同步内存快照：同周后续义务（含加罚）不会重复落点
      if (!assignments.has(plan.dateStr)) assignments.set(plan.dateStr, []);
      assignments.get(plan.dateStr).push({ name: o.name, position: plan.position });
      // 逐条即时标记 placed（2026-09-13）：写表成功但标记前中断会导致下次重复安置；
      // 按 id 定向 mutate，不整包回写旧快照（避免覆盖并发状态变更）
      state.mutate((st) => {
        for (const o2 of st.obligations) {
          if (o2.id === o.id) {
            o2.placed = true;
            o2.placedAt = new Date().toISOString();
            o2.placedDate = plan.dateStr;
            o2.placedPosition = plan.position;
            o2.placedFillLeave = Boolean(plan.fillLeave);
          }
        }
      });
    }
    if (!plan.fillLeave) weeklyInserted.set(o.weekStart, (weeklyInserted.get(o.weekStart) || 0) + 1);
    placed.push({ ...o, plan });
  }

  return { placed, stillQueued, deferred, expired };
}

/**
 * 每日 00:30 对账：
 * 1) 补收口：错过收口的日子（宕机/重启），把空状态置未做完 + 登记补偿 + 重算总状态
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

  // 3) 缺勤补偿同步：昨日记录中「已请假 / 未做完」两类（含 admin 手工改的状态）都进下周队列
  const syncedCount = syncAbsenceObligations(yesterday, recs);

  // 4) 昨日已完成值日的成员，连续缺勤计数清零
  if (!dryRun) {
    for (const r of recs) {
      if (r.status === config.status.DONE) resetStreak(r.name);
    }
  }

  // 5) 补偿义务安置
  const { placed, stillQueued, deferred, expired } = await placePending({ dryRun });

  // 顺延原因分别计数展示（deferReason：空=当周该队员天天有班 / 'weekly_allowance'=周插入
  // 容量已满）——混合时只报一种会把 weekly_allowance 吞掉
  const deferredFullWeek = deferred.filter((d) => d.deferReason !== 'weekly_allowance');
  const deferredAllowance = deferred.filter((d) => d.deferReason === 'weekly_allowance');
  const deferReasonParts = [];
  if (deferredFullWeek.length > 0) deferReasonParts.push(`当周该队员天天有班 ${deferredFullWeek.length} 条`);
  if (deferredAllowance.length > 0) deferReasonParts.push(`当周插入容量已满 ${deferredAllowance.length} 条`);
  const lines = [
    `🧹 值日对账（${yesterday}）`,
    `- 昨日总状态：${recs.length === 0 ? '无记录' : target || '未完成（保持为空）'}${dayStatusChanged ? '（已按表格实况修正）' : ''}`,
  ];
  for (const b of backfilled) {
    lines.push(`- ⚠️ 补收口 ${b.date}：${b.count} 人未确认已置未做完（${b.names.join('、')}），补偿义务已登记`);
  }
  lines.push(`- 补偿插入：本次安置 ${placed.length} 条，排队中 ${stillQueued.length} 条${deferred.length ? `，顺延 ${deferred.length} 条（${deferReasonParts.join('、')}，自动顺延下一周）` : ''}${expired.length ? `，过期标记 ${expired.length} 条（目标周已过去，请人工裁决）` : ''}${syncedCount ? `，补登记 ${syncedCount} 条（表格手工标记的请假/未做完）` : ''}`);
  for (const p of placed) {
    lines.push(`  · ${p.name} → ${p.plan.dateStr} ${p.plan.position}（${p.reason}）`);
  }
  for (const d of deferred) {
    lines.push(`  · ${d.name} 义务顺延至 ${d.weekStart} 起的周（${d.reason}）`);
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

  return { dayStatusChanged, yesterdayStatus: target, backfilled, placed, stillQueued, deferred, expired, report };
}

module.exports = { handleAbsence, resetStreak, placePending, reconcile, syncAbsenceObligations };
