const config = require('../config');
const { addDays, todayStr } = require('../utils/dates');
const bot = require('../feishu/bot');
const client = require('../feishu/client');
const dutyTable = require('./dutyTableService');
const roster = require('./rosterService');
const state = require('./stateStore');
const compensation = require('./compensationService');
const scheduleService = require('./scheduleService');
const ddlConflict = require('./ddlConflictClient');
const plaza = require('./plaza');

// ============================================================
// 私信闭环：D-1 提醒 → 当日询问（18:30，开启监听会话）→ 是/否/照片写回
// → 22:00 收口（未回复置未做完、算当日总状态、生成补偿插入）→ 请假
//
// 监听对象仅限当日 3 名值日队员（按 open_id 匹配当日记录；未绑定成员
// 跳过私信、看板标注「未绑定」）。「是」与照片独立生效：照片先到先挂
// 对应岗位附件栏，「是」到了才置已做完（22:00 前均监听）。
// 收口的写表动作不延迟（晚间静默语义），只有回执通知由调用方过闸门。
// ============================================================

const POSITION_DUTY = {
  '总负责': '监督当日值日完成情况，负责倒垃圾、更换垃圾袋',
  '工位区': '打扫工位区及中间区域地面，整理桌面物品与杂物',
  '装配区': '打扫装配区卫生，清理装配产生的杂物并归拢废料',
};

function positionDutyText(position) {
  return POSITION_DUTY[position] || '按岗位说明完成值日';
}

/**
 * D-1 20:00 次日提醒：私信明日值日队员（岗位 + 职责说明 + 请假/查询引导）
 * @returns {{date, sent: number, skipped: Array, preview: Array}}
 */
async function sendPrevDayRemind(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const date = addDays(todayStr(), 1);
  const recs = await dutyTable.getRecordsByDate(date);

  const sent = [];
  const skipped = [];
  for (const rec of recs) {
    if (rec.status) { skipped.push({ name: rec.name, reason: `状态已是「${rec.status}」` }); continue; }
    const member = roster.findByName(rec.name);
    if (!member || !member.openId) {
      skipped.push({ name: rec.name || '（未绑定）', reason: '未绑定账号' });
      continue;
    }
    const text = [
      `🧹 提醒：明天（${date}）是你的值日日，岗位【${rec.position}】`,
      `职责：${positionDutyText(rec.position)}`,
      '',
      '· 想请假：回复「我要请假」',
      '· 想查询排班：回复「值日助手」',
      '· 明天 18:30 会私信问你完成情况，完成后回复「打卡」并上传现场照片（照片会写入值日表）',
    ].join('\n');
    if (dryRun) {
      sent.push({ name: member.name, position: rec.position, preview: text });
    } else {
      await bot.sendTextToUser(member.openId, text);
      sent.push({ name: member.name, position: rec.position });
    }
  }

  return { date, sent, skipped, preview: sent.map((s) => `${s.name}（${s.position}）`) };
}

/**
 * D 日 18:30 当日询问：私信当日未完结队员，开启监听会话
 * @returns {{date, asked: number, skipped: Array, preview: Array}}
 */
async function askToday(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const date = todayStr();
  const recs = await dutyTable.getRecordsByDate(date);

  const asked = [];
  const skipped = [];
  for (const rec of recs) {
    if (rec.status) { skipped.push({ name: rec.name, reason: `状态已是「${rec.status}」` }); continue; }
    const member = roster.findByName(rec.name);
    if (!member || !member.openId) {
      skipped.push({ name: rec.name || '（未绑定）', reason: '未绑定账号' });
      continue;
    }
    const lines = [
      `🧹 今天（${date}）值日完成了吗？你的岗位是【${rec.position}】`,
      `职责：${positionDutyText(rec.position)}`,
      '',
      '完成后请回复「打卡」完成值日打卡，并上传现场照片（照片会写入值日表对应岗位栏）。',
      '22:00 统一收口，未打卡会记为「未做完」；想请假回复「我要请假」。',
    ];
    // 有未过期的 DDL 逾期确认时加冲突提示（2026-09-13 口径：值日打卡用「打卡」，
    // 回复「是」会确认 DDL 项目而非打卡；hub 查不到时静默降级不加提示）
    if (await ddlConflict.hasPendingDdlConfirm(member.openId)) {
      lines.push('⚠️ 你有一条 DDL 逾期确认待回复：回复「是」会确认那个项目（12 小时内有效），不会完成值日打卡——值日请回复「打卡」。');
    }
    const text = lines.join('\n');
    if (dryRun) {
      asked.push({ name: member.name, position: rec.position, preview: text });
    } else {
      await bot.sendTextToUser(member.openId, text);
      state.mutate((s) => {
        s.sessions[member.openId] = {
          date,
          recordId: rec.recordId,
          name: member.name,
          position: rec.position,
          askedAt: new Date().toISOString(),
        };
      });
      asked.push({ name: member.name, position: rec.position });
    }
  }

  return { date, asked, skipped, preview: asked.map((a) => `${a.name}（${a.position}）`) };
}

/** 会话里找当日记录（重新查表拿最新状态，会话只作身份与岗位锚点）。
 *  日期守卫：过期会话（错过收口的残留）直接清理，晚到的「是/否/照片」一律不认。 */
async function sessionRecord(openId) {
  const s = state.load();
  const session = s.sessions[openId];
  if (!session) return { session: null, rec: null, member: null };
  if (session.date !== todayStr()) {
    state.mutate((st) => { delete st.sessions[openId]; });
    return { session: null, rec: null, member: null };
  }
  const member = roster.findByOpenId(openId);
  const recs = await dutyTable.getRecordsByDate(session.date);
  const rec = recs.find((r) => r.recordId === session.recordId) || null;
  return { session, rec, member };
}

/** 队员回「是」：完成状态 → 已做完（照片仍可在 22:00 前补传） */
async function handleYes(openId) {
  const { session, rec, member } = await sessionRecord(openId);
  if (!session || !rec) {
    return { handled: false, reply: '今天没有进行中的值日确认。发「值日助手」可查询你的排班与用法。' };
  }
  if (rec.status === config.status.LEAVE) {
    return { handled: true, reply: '你今天的值日已登记请假，无需再确认。' };
  }
  if (rec.status === config.status.DONE) {
    return { handled: true, reply: '✅ 你今天的值日此前已记录完成，记得把现场照片发我（22:00 前均可）。' };
  }
  await dutyTable.setStatus(rec.recordId, config.status.DONE);
  compensation.resetStreak(session.name);
  plaza.append({ event: '值日完成', title: `${session.name}（${session.position}）` });
  const photos = rec.receiptCounts[session.position] || 0;
  return {
    handled: true,
    reply: photos > 0
      ? '✅ 已记录今日值日完成（照片已收到）。辛苦了！'
      : '✅ 已记录今日值日完成。记得把现场照片发我（会写入值日表对应岗位栏），22:00 前均可补传。',
  };
}

/** 队员回「否」：不改状态（22:00 收口置未做完），回执提醒可补救 */
async function handleNo(openId) {
  const { session, rec } = await sessionRecord(openId);
  if (!session || !rec) {
    return { handled: false, reply: '今天没有进行中的值日确认。发「值日助手」可查询你的排班与用法。' };
  }
  return {
    handled: true,
    reply: '收到。22:00 收口前你仍可以：补传现场照片 + 回复「打卡」完成打卡；或回复「我要请假」登记请假。',
  };
}

/** 打卡确认口语变体（是的/好/完成了…）：有当日活跃询问会话才等同「是」；
 *  无会话返回 handled:false + 空回复，hub 侧落回常规流程（欢迎语），不发未识别提示 */
async function confirmVariant(openId) {
  const { session } = await sessionRecord(openId);
  if (!session) return { handled: false, reply: '' };
  return handleYes(openId);
}

/**
 * 监听窗口内收到的图片：下载 → 转存多维表格 → 追加到本人岗位附件栏
 * @param {object} p { openId, imageKey, messageId }
 */
async function handleImage({ openId, imageKey, messageId }) {
  if (!openId || !imageKey) {
    return { handled: false, reply: '' };
  }
  const { session, rec } = await sessionRecord(openId);
  if (!session || !rec) {
    return { handled: false, reply: '今天没有进行中的值日确认，照片暂不收集。发「值日助手」可查询你的排班。' };
  }

  const buf = await client.downloadImage(imageKey);
  const fileName = `duty_${session.date}_${session.position}_${session.name}_${(messageId || Date.now()).toString().slice(-8)}.jpg`;
  const fileToken = await client.uploadMediaToBitable(buf, fileName);
  const count = await dutyTable.appendReceipt(rec.recordId, session.position, fileToken);
  const doneMarked = rec.status === config.status.DONE;
  return {
    handled: true,
    reply: `📸 已收到第 ${count} 张照片，写入「${session.position}」凭证栏。`
      + (doneMarked ? '今日值日已完成，辛苦了！' : '完成后记得回复「打卡」，22:00 前有效。'),
  };
}

/**
 * D 日 22:00 收口：
 * - 仍未回复「是」者置「未做完」（已传照片但没答「是」的同样置未做完）；
 * - 计算当日总状态（三个附件栏各有照片且全部已做完 → 今日完成值日）；
 * - 未做完成员生成下周补偿插入义务（已请假者在请假当时已生成）；
 * - 清空当日监听会话。
 * 写表动作不做静默延迟；返回的 notifications 由调用方决定直接发送或过闸门补发。
 * @returns {{date, results: Array, dayStatus, notifications: {photoOnly: Array, adminText: string}}}
 */
async function closeToday(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const date = todayStr();
  const recs = await dutyTable.getRecordsByDate(date);

  const results = [];
  const effective = [];
  for (const rec of recs) {
    let status = rec.status;
    let marked = false;
    if (!status) {
      status = config.status.MISS;
      marked = true;
      if (!dryRun) await dutyTable.setStatus(rec.recordId, status);
    }
    const photos = Object.values(rec.receiptCounts).some((n) => n > 0);
    effective.push({ ...rec, status, photos });
    results.push({ name: rec.name || '（未绑定）', position: rec.position, status, photos, markedNow: marked });
  }

  // 当日总状态
  const dayStatus = dutyTable.computeDayStatus(effective);
  if (!dryRun) {
    await dutyTable.setDayStatus(recs.map((r) => r.recordId), dayStatus);
  }

  // 未做完 → 补偿插入义务（已请假在请假当时已登记，不重复）
  if (!dryRun) {
    for (const rec of effective) {
      if (rec.status === config.status.MISS && rec.name) {
        compensation.handleAbsence(rec.name, date, config.status.MISS);
      }
    }
    // 清空当日会话并记录收口水位（供 00:30 对账补收口判断）
    state.mutate((s) => {
      for (const [openId, session] of Object.entries(s.sessions)) {
        if (session.date === date) delete s.sessions[openId];
      }
      s.lastCloseDate = date;
    });
  }

  // 通知载荷（一次性事件通知：静默窗口内落盘补发）
  const photoOnly = effective
    .filter((r) => r.photos && r.status === config.status.MISS)
    .map((r) => ({ name: r.name, position: r.position, openId: (roster.findByName(r.name) || {}).openId || '' }));
  const missList = results.filter((r) => r.status === config.status.MISS);
  const leaveList = results.filter((r) => r.status === config.status.LEAVE);
  const adminLines = [
    `🧹 值日收口（${date}）`,
    `- 当日总状态：${dayStatus || '未完成（保持为空）'}`,
    `- 未做完 ${missList.length} 人${missList.length ? '：' + missList.map((r) => `${r.name}（${r.position}${r.photos ? '，有照片未答是' : ''}）`).join('、') : ''}`,
    `- 请假 ${leaveList.length} 人${leaveList.length ? '：' + leaveList.map((r) => `${r.name}（${r.position}）`).join('、') : ''}`,
    `- 补偿插入义务已登记（下周生效），00:30 对账核对安置`,
  ];

  return {
    date,
    results,
    dayStatus,
    notifications: {
      photoOnly,
      adminText: adminLines.join('\n'),
    },
  };
}

/**
 * 请假：当次值日记录置「已请假」，回执确认，并登记下周补偿插入义务。
 * 连续排班/多条未完结时取最近一次，回执点名日期。
 * @param {{name: string}} member 已按 open_id 解析出的成员
 */
async function requestLeave(member) {
  const today = todayStr();
  const all = await dutyTable.getAllDayRecords();
  const rec = all.find((r) => r.name === member.name && r.dateStr >= today && !r.status);
  if (!rec) {
    return { handled: true, reply: '近期没有待完成的值日安排，无需请假。发「值日助手」可查询排班。' };
  }

  await dutyTable.setStatus(rec.recordId, config.status.LEAVE);
  const { penalty } = compensation.handleAbsence(member.name, rec.dateStr, config.status.LEAVE);
  plaza.append({ event: '值日请假', title: `${member.name}（${rec.position}，${rec.dateStr}）` });

  // 请假当日补位（2026-09-12 口径）：从较远的排班抽调一人顶上；找不到候选则当日空缺
  let replacement = null;
  try {
    replacement = await scheduleService.arrangeReplacement({
      dateStr: rec.dateStr,
      position: rec.position,
      excludeName: member.name,
    });
  } catch (err) {
    console.error('[补位] 抽调失败（请假登记不受影响）:', err.message);
  }
  if (replacement && replacement.openId) {
    // 私信被抽调人（失败不阻断请假回执，日志留痕管理员可转告）
    try {
      await bot.sendTextToUser(
        replacement.openId,
        `🧹 补位通知：${rec.dateStr}（${rec.position}）的值日因 ${member.name} 请假，已安排你补位。\n`
        + '完成后请照常私信回复「打卡」并上传照片，22:00 前完成即可。谢谢你！',
      );
    } catch (err) {
      console.error(`[补位] 通知 ${replacement.name} 失败:`, err.message);
    }
  }

  const lines = [
    `✅ 已登记请假：${rec.dateStr}（${rec.position}）`,
    replacement
      ? `补位安排：已从较远的排班抽调 ${replacement.name} 当日顶上（你会收到下周补偿安排，工作量总量不变）。`
      : '暂无可抽调人选，当日该岗将空缺，管理员会另行安排。',
    `补偿安排：下周（${rec.dateStr} 所在周的下一周）会自动插入一次值日，生成排班表时优先安置。`,
  ];
  if (penalty) {
    lines.push('⚠️ 你已连续两次缺勤/请假，本次额外多插入一次值日。');
  }
  return { handled: true, reply: lines.join('\n') };
}

/** 发送收口回执（cron 静默冲刷补发与手动触发共用） */
async function sendCloseNotifications(notifications) {
  for (const item of notifications.photoOnly || []) {
    if (!item.openId) continue;
    try {
      await bot.sendTextToUser(
        item.openId,
        '🧹 今天的值日已按「未做完」收口：你上传了照片但没有回复「打卡」。下次记得照片 + 回复「打卡」才算完成哦。'
      );
    } catch (err) {
      console.error(`[收口] 照片未答是回执发送失败（${item.name}）:`, err.message);
    }
  }
  for (const openId of roster.getAdminOpenIds()) {
    try {
      await bot.sendTextToUser(openId, notifications.adminText);
    } catch (err) {
      console.error('[收口] 管理员收口摘要发送失败:', err.message);
    }
  }
}

module.exports = {
  positionDutyText,
  sendPrevDayRemind,
  askToday,
  handleYes,
  handleNo,
  confirmVariant,
  handleImage,
  closeToday,
  requestLeave,
  sendCloseNotifications,
};
