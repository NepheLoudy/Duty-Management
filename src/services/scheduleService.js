const config = require('../config');
const { addDays, diffDays, monthAdd, todayStr } = require('../utils/dates');
const algo = require('./scheduleAlgo');
const dutyTable = require('./dutyTableService');
const roster = require('./rosterService');
const state = require('./stateStore');

// ============================================================
// 排班生成与对外数据
// - generate：表格中最后一个已排日期的次日起，按日历生成 1 个月；
//   轮转跨批次连续（配额从表格既有记录反推）；补偿插入义务优先安置。
// - rebalance：清理未来未完成班次后重排，保留的未来已请假/未做完记录
//   既占配额（extraHistoryRecordIds）也占日容量（preassigned 预置，2026-09-27）。
// - getBrief：昨日结果 + 今日名单一次取齐（通用数据接口；pm-robot 消费方案已作废，2026-09-12 口径）。
// - getNextDuty：个人下一次值日查询。
// - 写链路互斥：generate/rebalance/placePending（compensation 侧）共用 withScheduleLock。
// ============================================================

// 排班写链路全局串行（2026-09-27，照 inquiryService.withLeaveLock 模式）：
// generate/rebalance/placePending 都是「读全表 → 写表」的读改写链，双管理员同刻
// 各触发一轮生成会交叉双写整月排班。低频管理操作，进程内全局链无性能影响。
let scheduleChain = Promise.resolve();
function withScheduleLock(fn) {
  const task = scheduleChain.then(fn, fn);
  scheduleChain = task.then(() => {}, () => {});
  return task;
}

/** 生成范围内的补偿插入义务（未安置且目标周与生成范围相交） */
function collectPendingInsertions(stateData, rangeStart, rangeEnd) {
  // 排序不含随机量（id 含随机后缀），保证同参数生成结果可复现
  return (stateData.obligations || [])
    .filter((o) => !o.placed && o.weekStart <= rangeEnd && addDays(o.weekStart, 6) >= rangeStart)
    .sort((a, b) => {
      if (a.weekStart !== b.weekStart) return a.weekStart < b.weekStart ? -1 : 1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .map((o) => ({ id: o.id, name: o.name, weekStartStr: o.weekStart, reason: o.reason }));
}

/**
 * 生成排班表（值日助手「生成排班表」/ 管理接口触发）
 * @param {object} [options]
 * @param {boolean} [options.dryRun] 只生成预览，不写表、不动补偿义务
 * @param {string} [options.startDateStr] 显式起始日（重排场景覆盖「最后已排日期次日」默认值）
 * @param {string[]} [options.extraHistoryRecordIds] 额外计入配额反推的记录 ID（重排保留的
 *   未来已请假/未做完记录：占配额避免同人同日重复排班，欠账由义务体系闭环）
 * @returns {{startDate, endDate, dayCount, recordCount, quotaReport, unplacedInsertions, preview}}
 */
async function generate(options = {}) {
  // 排班写链路全局串行（rebalance 内部走 generateLocked，不重复排队）
  return withScheduleLock(() => generateLocked(options));
}

async function generateLocked(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const extraIds = new Set(options.extraHistoryRecordIds || []);

  const allRecords = await dutyTable.getAllDayRecords();
  const lastDate = await dutyTable.getLastScheduledDateStr();
  const startDate = options.startDateStr || (lastDate ? addDays(lastDate, 1) : addDays(todayStr(), 1));
  const endDate = addDays(monthAdd(startDate, config.generate.months), -1);
  const dayCount = diffDays(endDate, startDate) + 1;

  const history = allRecords
    .filter((r) => r.name && r.position && (r.dateStr < startDate || extraIds.has(r.recordId)))
    .map((r) => ({ name: r.name, position: r.position, date: r.dateStr }));

  // 额外计入配额反推的记录若落在生成范围内（重排保留的未来已请假/未做完班次），
  // 同时种进日占用表：基排按剩余容量补、插入按既有逻辑填请假位（2026-09-27 检修——
  // 只占配额不占日容量会让该日照常叠满 3 条新基排，出现 5 记录日）
  const preassigned = allRecords
    .filter((r) => r.name && r.position && r.dateStr >= startDate && extraIds.has(r.recordId))
    .map((r) => ({ name: r.name, position: r.position, date: r.dateStr, status: r.status || '' }));

  const stateData = state.load();
  const insertions = collectPendingInsertions(stateData, startDate, endDate);

  // 生成前刷新通讯录名册（失败沿用本地名册，不阻断生成）
  try {
    await roster.syncFromContacts();
  } catch (err) {
    console.error('[名册] 生成前同步通讯录失败，沿用本地名册:', err.message);
  }
  const members = roster.getQueue();
  if (members.length === 0) {
    throw new Error('值日队列为空：请核对通讯录同步结果与白名单');
  }

  const result = algo.generateSchedule({
    members,
    startDateStr: startDate,
    days: dayCount,
    history,
    preassigned,
    insertions,
    minIntervalDays: config.generate.minIntervalDays,
    weeklyAllowance: options.weeklyAllowance != null ? options.weeklyAllowance : config.generate.weeklyInsertionAllowance,
    seedStr: `duty|${startDate}|${members.map((m) => m.name).join(',')}|${history.length}`,
  });

  if (!dryRun) {
    const createdIds = [];
    // 补偿义务按人排队：逐日写表成功后即时标记 placed（placePending v32 同款防御——
    // 写表中途中断时已写日的义务已落账，管理员重试生成不会二次安置造成双倍补偿）
    const pendingByMember = new Map();
    for (const ins of insertions) {
      if (!result.unplacedInsertions.includes(ins)) {
        if (!pendingByMember.has(ins.name)) pendingByMember.set(ins.name, []);
        pendingByMember.get(ins.name).push(ins.id);
      }
    }
    const markPlaced = (ids, dateStr) => {
      if (ids.length === 0) return;
      state.mutate((s) => {
        for (const o of s.obligations) {
          if (ids.includes(o.id)) {
            o.placed = true;
            o.placedAt = new Date().toISOString();
            o.placedDate = dateStr; // 与 placePending 同款：rebalance 义务重置按 placed && placedDate 判定，缺 placedDate 会让生成安置的义务重排后不被重置
            o.via = 'generate';
          }
        }
      });
    };
    for (const day of result.days) {
      const items = day.items
        .filter((it) => !it.kept) // 重排保留的既有记录已在表中，不得重写（防重复落表）
        .map((it) => ({
          member: roster.findByName(it.name) || { name: it.name },
          position: it.position,
          insertionName: it.isInsertion ? it.name : '',
        }))
        .filter((it) => Boolean(it.member));
      if (items.length === 0) continue; // 该日只剩保留记录，无新班次可写
      const ids = await dutyTable.createDayRecords(day.date, items);
      createdIds.push(...ids);
      const dayPlaced = [];
      for (const it of items) {
        if (!it.insertionName) continue;
        const q = pendingByMember.get(it.insertionName);
        if (q && q.length > 0) dayPlaced.push(q.shift());
      }
      markPlaced(dayPlaced, day.date);
    }
  }

  const recordCount = result.days.reduce((n, d) => n + d.items.length, 0);
  return {
    startDate,
    endDate,
    dayCount,
    recordCount,
    days: result.days,
    quotaReport: result.quotaReport,
    unplacedInsertions: result.unplacedInsertions,
    preview: renderPreview(result.days),
    dryRun,
  };
}

/** 生成结果 → 逐日预览文本 */
function renderPreview(days) {
  return days.map((d) => {
    const line = d.items
      .map((it) => `${it.position}=${it.name}${it.isInsertion ? '(插入)' : ''}`)
      .join('，');
    return `${d.date}：${line}`;
  });
}

/** 生成结果 → 给权限人的回执文本（含配额核对表） */
function renderGenerateReply(result) {
  const lines = [];
  lines.push(`${result.dryRun ? '🧪 [dry-run 预览]' : '✅'} 排班表已生成：${result.startDate} ~ ${result.endDate}（${result.dayCount} 天 / ${result.recordCount} 条记录）`);
  lines.push('');
  lines.push('每人本次配额核对：');
  for (const q of result.quotaReport) {
    lines.push(`- ${q.name}：共 ${q.total} 次（总负责 ${q.counts['总负责']} / 工位区 ${q.counts['工位区']} / 装配区 ${q.counts['装配区']}）`);
  }
  if (result.unplacedInsertions.length > 0) {
    lines.push('');
    lines.push(`⚠️ 有 ${result.unplacedInsertions.length} 条补偿插入在目标周找不到空位，保留在队列中待下次安置`);
  }
  if (result.dryRun && result.preview.length > 0) {
    lines.push('');
    lines.push('逐日预览（前 10 天）：');
    for (const line of result.preview.slice(0, 10)) lines.push(line);
    if (result.preview.length > 10) lines.push(`…其余 ${result.preview.length - 10} 天略`);
  }
  return lines.join('\n');
}

/**
 * 对外数据接口数据源：昨日结果 + 今日名单（通用数据接口，保留备用）
 * @returns {{yesterday: {date, dayStatus, members: Array}, today: {date, members: Array}}}
 */
async function getBrief() {
  const today = todayStr();
  const yesterday = addDays(today, -1);

  const all = await dutyTable.getAllDayRecords();
  const yRecs = all.filter((r) => r.dateStr === yesterday);
  const tRecs = all.filter((r) => r.dateStr === today);

  const yDayStatus = dutyTable.computeDayStatus(yRecs)
    || yRecs.map((r) => r.dayStatus).find(Boolean)
    || null;

  return {
    yesterday: {
      date: yesterday,
      dayStatus: yDayStatus,
      members: yRecs.map((r) => ({
        name: r.name || '未绑定',
        position: r.position,
        status: r.status || '待定',
        hasReceipt: Object.values(r.receiptCounts).some((n) => n > 0),
      })),
    },
    today: {
      date: today,
      members: tRecs.map((r) => ({ name: r.name || '未绑定', position: r.position })),
    },
  };
}

/** 个人下一次值日（未来日期、未完结的最早记录） */
async function getNextDuty(memberName) {
  const today = todayStr();
  const all = await dutyTable.getAllDayRecords();
  const rec = all.find((r) => r.name === memberName && r.dateStr >= today && !r.status);
  if (!rec) return null;
  return { date: rec.dateStr, position: rec.position };
}

/**
 * 排班重排（2026-09-25 检修）：清理存量超员——删除「今天之后未完成」的班次记录，
 * 保留历史与已定状态（已请假/未做完）记录，被删班次对应的补偿义务重置为未安置，
 * 然后从明天起按算法重新生成（每天严格 3 人；请假空缺位由义务安置按新优先级回填）。
 * 执行前把全表原始记录 JSON 备份到状态文件同级的 backup/ 目录。
 * @param {object} [options]
 * @param {boolean} [options.confirm] 默认 false=只预览；true 才真正删表重排
 * @returns {object} 预览或执行结果（删除清单/义务重置/新生成概要）
 */
async function rebalance(options = {}) {
  // 与 generate/placePending 共用全局串行锁（rebalance 内部的生成走 generateLocked 不重复排队）
  return withScheduleLock(() => rebalanceLocked(options));
}

async function rebalanceLocked(options = {}) {
  const confirm = Boolean(options.confirm);
  const today = todayStr();
  const all = await dutyTable.getAllDayRecords();

  // 划分：>today 且无状态 → 删除重排；其余保留（历史留痕、今天进行中、已请假/未做完事实）
  const toDelete = all.filter((r) => r.dateStr > today && !r.status);
  const kept = all.filter((r) => !toDelete.includes(r));
  const deleteDates = new Set(toDelete.map((r) => r.dateStr));

  // 义务重置：已安置但落点在被删日期上的 → 重置为未安置，随新排班重新安置
  const s = state.load();
  const resetOb = (s.obligations || []).filter(
    (o) => o.placed && o.placedDate && deleteDates.has(o.placedDate)
  );

  const byDate = {};
  for (const r of toDelete) {
    (byDate[r.dateStr] = byDate[r.dateStr] || []).push(`${r.name}(${r.position})`);
  }

  if (!confirm) {
    return {
      dryRun: true,
      today,
      deleteCount: toDelete.length,
      deleteByDate: byDate,
      keptCount: kept.length,
      keptFuture: kept.filter((r) => r.dateStr > today).map((r) => `${r.dateStr} ${r.name}(${r.position},${r.status})`),
      resetObligations: resetOb.map((o) => `${o.name} ${o.reason.slice(0, 16)} @${o.placedDate}`),
    };
  }

  // 1) 全表原始记录备份（重排不可逆动作前的完整快照）
  const fs = require('fs');
  const path = require('path');
  const raw = await dutyTable.getAllRawRecords();
  let backupPath;
  try {
    const backupDir = path.join(path.dirname(config.stateFile), 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `rebalance-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ exportedAt: new Date().toISOString(), records: raw }, null, 2));
  } catch (err) {
    throw new Error(`重排中止：备份写入失败（${err.message}）——不备份不删除`);
  }
  if (raw.length === 0) {
    throw new Error('重排中止：全表读取为空，拒绝在空快照上执行删除');
  }

  // 2) 删除待重排记录
  await dutyTable.batchDeleteRecords(toDelete.map((r) => r.recordId));

  // 3) 义务重置（placed → false，清安置痕迹；dutyDate<=today 的历史义务不动）
  if (resetOb.length > 0) {
    const resetIds = new Set(resetOb.map((o) => o.id));
    state.mutate((st) => {
      for (const o of st.obligations) {
        if (resetIds.has(o.id)) {
          o.placed = false;
          delete o.placedAt;
          delete o.placedDate;
          delete o.placedPosition;
          delete o.placedFillLeave;
        }
      }
    });
  }

  // 4) 从明天起重排：保留的未来已请假/未做完记录计入配额反推（占配额防同人同日重复排班），
  //    并经 generateLocked 的 preassigned 种进日占用表（占日容量防 5 记录日，2026-09-27）
  const gen = await generateLocked({
    dryRun: false,
    startDateStr: addDays(today, 1),
    weeklyAllowance: options.weeklyAllowance,
    extraHistoryRecordIds: kept.filter((r) => r.dateStr > today).map((r) => r.recordId),
  });

  console.log(`[重排] 删除 ${toDelete.length} 条未完成班次，重置 ${resetOb.length} 条义务，重新生成 ${gen.recordCount} 条（备份: ${backupPath}）`);
  return {
    dryRun: false,
    today,
    backupPath,
    deleteCount: toDelete.length,
    resetObligationCount: resetOb.length,
    generated: { startDate: gen.startDate, endDate: gen.endDate, recordCount: gen.recordCount },
    quotaReport: gen.quotaReport,
    unplacedInsertions: gen.unplacedInsertions,
  };
}

module.exports = {
  generate,
  withScheduleLock,
  renderGenerateReply,
  getBrief,
  getNextDuty,
  collectPendingInsertions,
  rebalance,
};
