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
// - getBrief：昨日结果 + 今日名单一次取齐（pm-robot 每日播报数据源）。
// - getNextDuty：个人下一次值日查询。
// ============================================================

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
 * @returns {{startDate, endDate, dayCount, recordCount, quotaReport, unplacedInsertions, preview}}
 */
async function generate(options = {}) {
  const dryRun = Boolean(options.dryRun);

  const allRecords = await dutyTable.getAllDayRecords();
  const lastDate = await dutyTable.getLastScheduledDateStr();
  const startDate = lastDate ? addDays(lastDate, 1) : addDays(todayStr(), 1);
  const endDate = addDays(monthAdd(startDate, config.generate.months), -1);
  const dayCount = diffDays(endDate, startDate) + 1;

  const history = allRecords
    .filter((r) => r.dateStr < startDate && r.name && r.position)
    .map((r) => ({ name: r.name, position: r.position, date: r.dateStr }));

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
    insertions,
    minIntervalDays: config.generate.minIntervalDays,
    seedStr: `duty|${startDate}|${members.map((m) => m.name).join(',')}|${history.length}`,
  });

  if (!dryRun) {
    const createdIds = [];
    for (const day of result.days) {
      const items = day.items
        .map((it) => ({ member: roster.findByName(it.name) || { name: it.name }, position: it.position }))
        .filter((it) => Boolean(it.member));
      const ids = await dutyTable.createDayRecords(day.date, items);
      createdIds.push(...ids);
    }

    // 已安置的补偿义务标记 placed；未安置（周内无空位）保留排队
    const placedIds = new Set(insertions.filter((ins) => !result.unplacedInsertions.includes(ins)).map((ins) => ins.id));
    if (placedIds.size > 0) {
      state.mutate((s) => {
        for (const o of s.obligations) {
          if (placedIds.has(o.id)) {
            o.placed = true;
            o.placedAt = new Date().toISOString();
            o.via = 'generate';
          }
        }
      });
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
 * 对外数据接口数据源：昨日结果 + 今日名单（pm-robot 每日 12:00 播报调用）
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

module.exports = {
  generate,
  renderGenerateReply,
  getBrief,
  getNextDuty,
  collectPendingInsertions,
};
