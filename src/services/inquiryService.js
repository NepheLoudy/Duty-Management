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
// → 24:00（午夜）收口（未回复置未做完、算当日总状态、生成补偿插入）→ 请假
//
// 监听对象仅限当日 3 名值日队员（按 open_id 匹配当日记录；未绑定成员
// 跳过私信、看板标注「未绑定」）。「是」与照片独立生效：照片先到先挂
// 对应岗位附件栏，「是」到了才置已做完（收口前均监听）。
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
      try {
        await bot.sendTextToUser(member.openId, text);
        sent.push({ name: member.name, position: rec.position });
      } catch (err) {
        skipped.push({ name: member.name, reason: `提醒发送失败: ${err.message}` });
        console.error(`[提醒] ${member.name} 发送失败:`, err.message);
      }
    }
  }

  return { date, sent, skipped, preview: sent.map((s) => `${s.name}（${s.position}）`) };
}

/**
 * D-7 20:05 值日预告（2026-09-24 新增）：私信一周后的当日值日队员。
 * 动机：被补偿/加罚插入的班次队员往往临近才发现自己有班（临时请假牵动补位），
 * 提前一周点名，留足请假/换安排的余量。预告不带打卡指引（D-1 20:00 次日提醒再发详细版）。
 * @returns {{date, sent: number, skipped: Array, preview: Array}}
 */
async function sendWeekAheadRemind(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const date = addDays(todayStr(), 7);
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
      `📅 值日预告：一周后（${date}）是你的值日日，岗位【${rec.position}】`,
      `职责：${positionDutyText(rec.position)}`,
      '',
      '提前留意当天的时间安排；如需请假，届时回复「我要请假」即可（会安排补位，下周自动补一次值日）。',
    ].join('\n');
    if (dryRun) {
      sent.push({ name: member.name, position: rec.position, preview: text });
    } else {
      try {
        await bot.sendTextToUser(member.openId, text);
        sent.push({ name: member.name, position: rec.position });
      } catch (err) {
        skipped.push({ name: member.name, reason: `预告发送失败: ${err.message}` });
        console.error(`[预告] ${member.name} 发送失败:`, err.message);
      }
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
      '24:00（午夜）统一收口，未打卡会记为「未做完」；想请假回复「我要请假」。',
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
      // 逐人异常隔离（2026-09-13）：单个成员发送失败（如 230013 不在应用可用范围）
      // 不再中断整轮——剩余成员照常收到询问与会话
      try {
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
      } catch (err) {
        skipped.push({ name: member.name, reason: `询问发送失败: ${err.message}` });
        console.error(`[询问] ${member.name} 发送失败:`, err.message);
      }
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

/** 队员回「是」：完成状态 → 已做完（照片仍可在收口前补传） */
async function handleYes(openId) {
  const { session, rec, member } = await sessionRecord(openId);
  if (!session || !rec) {
    return { handled: false, reply: '今天没有进行中的值日确认。发「值日助手」可查询你的排班与用法。' };
  }
  if (rec.status === config.status.LEAVE) {
    return { handled: true, reply: '你今天的值日已登记请假，无需再确认。' };
  }
  if (rec.status === config.status.DONE) {
    return { handled: true, reply: '✅ 你今天的值日此前已记录完成，记得把现场照片发我（收口前均可）。' };
  }
  await dutyTable.setStatus(rec.recordId, config.status.DONE);
  compensation.resetStreak(session.name);
  plaza.append({ event: '值日完成', title: `${session.name}（${session.position}）` });
  const photos = rec.receiptCounts[session.position] || 0;
  return {
    handled: true,
    reply: photos > 0
      ? '✅ 已记录今日值日完成（照片已收到）。辛苦了！'
      : '✅ 已记录今日值日完成。记得把现场照片发我（会写入值日表对应岗位栏），收口前均可补传。',
  };
}

/** 队员回「否」：不改状态（收口置未做完），回执提醒可补救 */
async function handleNo(openId) {
  const { session, rec } = await sessionRecord(openId);
  if (!session || !rec) {
    return { handled: false, reply: '今天没有进行中的值日确认。发「值日助手」可查询你的排班与用法。' };
  }
  return {
    handled: true,
    reply: '收到。24:00（午夜）收口前你仍可以：补传现场照片 + 回复「打卡」完成打卡；或回复「我要请假」登记请假。',
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
 * @param {object} p { openId, imageKey?, imageKeys?, messageId }
 *   imageKeys（2026-09-17）：富文本/post 一次多图时 hub 全量透传，逐张收录后合并回执
 */
async function handleImage({ openId, imageKey, imageKeys, messageId }) {
  const keys = (Array.isArray(imageKeys) && imageKeys.length ? imageKeys : [imageKey]).filter(Boolean);
  if (!openId || keys.length === 0) {
    return { handled: false, reply: '' };
  }
  const { session, rec } = await sessionRecord(openId);
  if (!session || !rec) {
    return { handled: false, reply: '今天没有进行中的值日确认，照片暂不收集。发「值日助手」可查询你的排班。' };
  }

  const base = String(messageId || Date.now()).slice(-8);
  let count = 0;
  for (const [i, key] of keys.entries()) {
    const buf = await client.downloadImage(messageId, key);
    const fileName = `duty_${session.date}_${session.position}_${session.name}_${base}_${i + 1}.jpg`;
    const fileToken = await client.uploadMediaToBitable(buf, fileName);
    count = await dutyTable.appendReceipt(rec.recordId, session.position, fileToken);
  }
  const doneMarked = rec.status === config.status.DONE;
  console.log(`[图片] 已收录 ${keys.length} 张 → ${session.name}/${session.position}（该岗累计 ${count} 张，消息尾号 ${base}）`);
  const plural = keys.length > 1 ? `共 ${keys.length} 张，` : '';
  return {
    handled: true,
    reply: `📸 已收到${plural}写入「${session.position}」凭证栏（该岗累计 ${count} 张）。`
      + (doneMarked ? '今日值日已完成，辛苦了！' : '完成后记得回复「打卡」，收口（24:00）前有效。'),
  };
}

/**
 * D 日 21:00 临门提醒（收口前 1 小时）：私信当日仍未完结队员（可重扫任务，过静默闸门）。
 * 2026-09-16 新增：18:30 询问后到收口之间无任何再触达，成员忘了就是「未做完」。
 * @returns {{date, sent: number, skipped: Array, preview: Array}}
 */
async function sendLastCall(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const date = todayStr();
  const recs = await dutyTable.getRecordsByDate(date);

  const sent = [];
  const skipped = [];
  for (const rec of recs) {
    if (rec.status) continue; // 已完结（做完/请假/未做完）不再打扰
    const member = roster.findByName(rec.name);
    if (!member || !member.openId) {
      skipped.push({ name: rec.name || '（未绑定）', reason: '未绑定账号' });
      continue;
    }
    const photos = Object.values(rec.receiptCounts).some((n) => n > 0);
    const lines = [
      `⏰ 提醒：今天（${date}）值日 24:00（午夜）收口，还剩约 1 小时——你的【${rec.position}】还没完成打卡。`,
      photos
        ? '照片已收到 ✅，回复「打卡」即完成值日。'
        : '完成后回复「打卡」并上传现场照片（照片会写入值日表）。',
      '确实做不完：回复「我要请假」，或收口后记「未做完」（下周自动补偿一次）。查询排班发「值日助手」。',
    ];
    const text = lines.join('\n');
    if (dryRun) {
      sent.push({ name: member.name, position: rec.position, preview: text });
      continue;
    }
    try {
      await bot.sendTextToUser(member.openId, text);
      sent.push({ name: member.name, position: rec.position });
    } catch (err) {
      skipped.push({ name: member.name, reason: `临门提醒发送失败: ${err.message}` });
      console.error(`[临门提醒] ${member.name} 发送失败:`, err.message);
    }
  }
  return { date, sent, skipped, preview: sent.map((s) => `${s.name}（${s.position}）`) };
}

/**
 * D 日 24:00（午夜）收口：
 * - 仍未回复「是」者置「未做完」（已传照片但没答「是」的同样置未做完）；
 * - 计算当日总状态（三个附件栏各有照片且全部已做完 → 今日完成值日）；
 * - 未做完成员生成下周补偿插入义务（已请假者在请假当时已生成）；
 * - 清空当日监听会话。
 * 写表动作不做静默延迟；返回的 notifications 由调用方决定直接发送或过闸门补发。
 * @returns {{date, results: Array, dayStatus, notifications: {photoOnly: Array, adminText: string}}}
 */
async function closeToday(options = {}) {
  const dryRun = Boolean(options.dryRun);
  // 24:00（0 点）收口跨日：调用方（cron deadline runner）显式传归属日期（=值日当天 D 日）；
  // 手动 test-close 不传时取「今天」
  const date = options.dateStr || todayStr();
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
    effective.push({ ...rec, status, photos, markedNow: marked });
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
      // 幂等守卫（2026-09-13）：只对本轮实际置「未做完」的记录登记补偿——
      // 同日第二次收口（手动 test-close 默认真实执行 + cron）否则会双计义务并虚增连续缺勤
      if (rec.status === config.status.MISS && rec.name && rec.markedNow) {
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
  const unnotified = results.filter((r) => r.status === config.status.MISS && r.name && !(roster.findByName(r.name) || {}).openId);
  // 未做完者本人私信通知（2026-09-16：此前只有管理员摘要，未做完者本人毫无感知）
  const missNotices = results
    .filter((r) => r.status === config.status.MISS && r.name && r.markedNow)
    .map((r) => ({ name: r.name, position: r.position, photos: r.photos, openId: (roster.findByName(r.name) || {}).openId || '' }));
  const leaveList = results.filter((r) => r.status === config.status.LEAVE);
  const adminLines = [
    `🧹 值日收口（${date}）`,
    `- 当日总状态：${dayStatus || '未完成（保持为空）'}`,
    `- 未做完 ${missList.length} 人${missList.length ? '：' + missList.map((r) => `${r.name}（${r.position}${r.photos ? '，有照片未答是' : ''}${(roster.findByName(r.name) || {}).openId ? '' : '，未绑定未通知'}）`).join('、') : ''}`,
    `- 请假 ${leaveList.length} 人${leaveList.length ? '：' + leaveList.map((r) => `${r.name}（${r.position}）`).join('、') : ''}`,
    `- 补偿插入义务已登记（下周生效），00:30 对账核对安置`,
  ];

  return {
    date,
    results,
    dayStatus,
    notifications: {
      photoOnly,
      missNotices,
      adminText: adminLines.join('\n'),
    },
  };
}

/**
 * 请假：当次值日记录置「已请假」，回执确认，并登记下周补偿插入义务。
 * 连续排班/多条未完结时取最近一次，回执点名日期。
 * @param {{name: string}} member 已按 open_id 解析出的成员
 */
// 请假链路全局串行（2026-09-13）：读全表→选候选→写补位记录是读改写链，
// 并发请假（跨成员）会选中同一候选造成同日同岗双插——请假低频，全局链无性能影响
let leaveChain = Promise.resolve();
function withLeaveLock(fn) {
  const task = leaveChain.then(fn, fn);
  leaveChain = task.then(() => {}, () => {});
  return task;
}

// 请假二次确认（2026-09-24）：「我要请假」只登记意向，回执点名日期，
// 回复「确认请假」才真正生效——旧版直取最近班次立即置请假，误触一次就少一个班
// 且牵动补位/补偿，无法撤回。确认会话惰性过期（不设定时器，下一次交互时校验）。
const PENDING_LEAVE_TTL_MS = 10 * 60 * 1000;

function pendingLeaveOf(openId) {
  const pending = state.load().pendingLeaves?.[openId];
  if (!pending) return null;
  if (Date.now() - Date.parse(pending.askedAt) > PENDING_LEAVE_TTL_MS) return null;
  return pending;
}

/** 「我要请假」第一步：登记请假意向（记录点名日期），等待「确认请假」 */
async function requestLeave(member) {
  const today = todayStr();
  const all = await dutyTable.getAllDayRecords();
  const rec = all.find((r) => r.name === member.name && r.dateStr >= today && !r.status);
  if (!rec) {
    return { handled: true, reply: '近期没有待完成的值日安排，无需请假。发「值日助手」可查询排班。' };
  }
  state.mutate((s) => {
    s.pendingLeaves = s.pendingLeaves || {};
    s.pendingLeaves[member.openId] = {
      recordId: rec.recordId,
      dateStr: rec.dateStr,
      position: rec.position,
      name: member.name,
      askedAt: new Date().toISOString(),
    };
  });
  return {
    handled: true,
    reply: [
      `🗓 请假确认：你将于 ${rec.dateStr}（${rec.position}）值日。`,
      '确认请假请回复「确认请假」（10 分钟内有效）；误触请回复「取消请假」。',
      '确认后：当次置已请假，当日由其他队员补位，下周自动补插一次值日。',
    ].join('\n'),
  };
}

/** 「确认请假」第二步：按确认会话里的记录执行请假（原请假链路） */
function confirmLeave(openId) {
  const pending = pendingLeaveOf(openId);
  if (!pending) {
    return { handled: true, reply: '没有待确认的请假。要请假请先发「我要请假」，再回复「确认请假」生效。' };
  }
  return withLeaveLock(async () => {
    const all = await dutyTable.getAllDayRecords();
    const rec = all.find((r) => r.recordId === pending.recordId);
    if (!rec || rec.status) {
      state.mutate((s) => { if (s.pendingLeaves) delete s.pendingLeaves[openId]; });
      const next = all.find((r) => r.name === pending.name && r.dateStr >= todayStr() && !r.status);
      return {
        handled: true,
        reply: next
          ? `该班次（${pending.dateStr}）已有状态或已变更，未执行请假。你近期还有 ${next.dateStr}（${next.position}）待完成，如需请假请重新发「我要请假」。`
          : '该班次已有状态或已变更，未执行请假。近期没有其他待完成的值日安排。',
      };
    }
    state.mutate((s) => { if (s.pendingLeaves) delete s.pendingLeaves[openId]; });
    return requestLeaveLocked({ name: pending.name, openId, recordId: rec.recordId });
  });
}

/** 「取消请假」：丢弃确认会话，班次不受影响 */
function cancelLeave(openId) {
  const had = Boolean(pendingLeaveOf(openId));
  state.mutate((s) => { if (s.pendingLeaves) delete s.pendingLeaves[openId]; });
  return {
    handled: true,
    reply: had
      ? '已取消请假，你的值日安排不变。'
      : '没有待确认的请假。要请假请先发「我要请假」。',
  };
}

async function requestLeaveLocked(member, knownRecordId) {
  const today = todayStr();
  const all = await dutyTable.getAllDayRecords();
  const rec = knownRecordId
    ? all.find((r) => r.recordId === knownRecordId)
    : all.find((r) => r.name === member.name && r.dateStr >= today && !r.status);
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
    // 私信被抽调人：后台发送不 await（2026-09-19）——请假链路整串是表读写+私信，
    // 串行发完才回执会顶爆 hub 转发超时（09-18 案例：请假登记成功但回执超时，
    // 用户私聊侧看到的是失败）；失败不阻断请假回执，日志留痕管理员可转告
    bot.sendTextToUser(
      replacement.openId,
      `🧹 补位通知：${rec.dateStr}（${rec.position}）的值日因 ${member.name} 请假，已安排你补位。\n`
      + '完成后请照常私信回复「打卡」并上传照片，收口（24:00）前完成即可。谢谢你！',
    ).catch((err) => console.error(`[补位] 通知 ${replacement.name} 失败:`, err.message));
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
  for (const item of notifications.missNotices || notifications.photoOnly || []) {
    if (!item.openId) continue;
    const text = item.photos
      ? '🧹 今天的值日已按「未做完」收口：你上传了照片但没有回复「打卡」。下次记得照片 + 回复「打卡」才算完成哦。'
      : `🧹 今天的值日已按「未做完」收口（${item.position}）。下周会自动插入一次补偿值日，届时留意私信提醒；如有特殊情况请私信「值日助手」或联系管理员。`;
    try {
      await bot.sendTextToUser(item.openId, text);
    } catch (err) {
      console.error(`[收口] 未做完私信发送失败（${item.name}）:`, err.message);
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
  sendWeekAheadRemind,
  sendLastCall,
  askToday,
  handleYes,
  handleNo,
  confirmVariant,
  handleImage,
  closeToday,
  requestLeave,
  confirmLeave,
  cancelLeave,
  sendCloseNotifications,
};
