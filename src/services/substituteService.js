// ============================================================
// 代班指定（2026-11-16 v97，曼波口径：请假补偿照记 + 拒/超时可再指定一轮）
// 数据模型：代班成功 = 班记录人员字段改为代班人（status 不动=正常值日）——
// 排班单一事实源生效后看板/询问/临门/收口全自动认代班人；请假人照记下周补偿
//（班被代=当日空缺被解决，但请假本身的补偿义务不豁免，曼波 2026-11-16 定）。
// 会话（双 10 分钟 TTL，cron 清扫兜底通知）：
//   pendingLeaves[].substitute  请假人侧 {name, openId, askedAt}
//   pendingSubstitutes          代班人侧 {recordId, dateStr, position, leaveName, leaveOpenId, askedAt}
// 流转：确认请假 [姓名] → 私信代班人 → 确认代班=换人写表+补偿登记+双方回执；
//   拒绝/超时 → 通知请假人可再指定（subRound 计数，MAX_ROUNDS 轮内）→ 用尽转空缺补偿。
// 写表互斥：withScheduleLock（与排班生成/补偿安置同链——换人=排班操作）。
// ============================================================
const config = require('../config');
const state = require('./stateStore');
const dutyTable = require('./dutyTableService');
const roster = require('./rosterService');
const bot = require('../feishu/bot');
const compensation = require('./compensationService');
const plaza = require('./plaza');
const { withScheduleLock } = require('./scheduleService');

const TTL_MS = 10 * 60 * 1000;
const MAX_ROUNDS = 2; // 最多指定 2 轮（首轮 + 1 次重试），用尽转空缺补偿

function pendingSubOf(subOpenId) {
  const p = (state.load().pendingSubstitutes || {})[subOpenId];
  if (!p) return null;
  if (Date.now() - Date.parse(p.askedAt) > TTL_MS) return null; // 惰性过期
  return p;
}

function leaveOf(leaveOpenId) {
  const p = state.load().pendingLeaves?.[leaveOpenId];
  if (!p) return null;
  if (Date.now() - Date.parse(p.askedAt) > TTL_MS) return null;
  return p;
}

/** 「确认请假 [姓名]」入口：解析代班人 → 建双会话 → 私信代班人（请假动作延迟到回执） */
function requestSubstitute(leaveOpenId, subName) {
  const pending = leaveOf(leaveOpenId);
  if (!pending) {
    return { handled: true, reply: '没有待确认的请假。请先发「我要请假」。' };
  }
  if ((pending.subRound || 0) >= MAX_ROUNDS) {
    return {
      handled: true,
      reply: '本轮请假已用完代班指定次数（最多两轮）。回复「确认请假」走补偿安排，或「取消请假」放弃。',
    };
  }
  const sub = roster.findByName(subName);
  if (!sub) {
    return {
      handled: true,
      reply: `名册里查不到「${subName}」。请重新回复「确认请假 姓名」指定代班人，或直接回复「确认请假」走补偿安排。`,
    };
  }
  if (sub.openId === leaveOpenId) {
    return { handled: true, reply: '不能指定你自己代班哦。回复「确认请假 姓名」指定其他人，或直接回复「确认请假」走补偿。' };
  }
  state.mutate((s) => {
    const p = s.pendingLeaves?.[leaveOpenId];
    if (!p) return;
    p.substitute = { name: sub.name, openId: sub.openId, askedAt: new Date().toISOString() };
    s.pendingSubstitutes = s.pendingSubstitutes || {};
    s.pendingSubstitutes[sub.openId] = {
      recordId: p.recordId,
      dateStr: p.dateStr,
      position: p.position,
      leaveName: p.name,
      leaveOpenId,
      askedAt: new Date().toISOString(),
    };
  });
  const subReply = [
    `👋 ${sub.name} 你好，${pending.name} 请了 ${pending.dateStr}（${pending.position}）的班，并指定你代班。`,
    `回复「确认代班」接下这个班；回复「拒绝代班」退回（10 分钟内有效，超时视为婉拒）。`,
  ].join('\n');
  // 私信 fire-and-forget：指令回执先返回；私信失败仅记日志，超时清扫会兜底通知请假人
  bot.sendTextToUser(sub.openId, subReply).catch((err) => console.error('[代班] 代班人私信失败:', err.message));
  return {
    handled: true,
    reply: `已向 ${sub.name} 发出代班确认私信（10 分钟内有效）。对方确认后完成改班：该班转为 ${sub.name} 正常值日；你的下周补偿按口径照常登记。若对方婉拒或超时，你会收到通知（届时可再指定一人或转补偿）。`,
  };
}

/** 「确认代班」：锁内重验 → 换人写表 → 请假人补偿登记 → 双方回执 */
function confirmSubstitute(subOpenId) {
  const subPending = pendingSubOf(subOpenId);
  if (!subPending) {
    return { handled: true, reply: '没有待你确认的代班请求。收到代班私信后才能回复「确认代班」。' };
  }
  return withScheduleLock(async () => {
    // 锁内重验（可能已被超时清扫/取消请假/新一轮指定清掉；askedAt 比对防错拿新一轮会话）
    const still = (state.load().pendingSubstitutes || {})[subOpenId];
    if (!still || still.askedAt !== subPending.askedAt) {
      return { handled: true, reply: '这条代班请求已失效（被取消、超时或已更新）。如仍愿意帮忙，请让请假人重新指定你。' };
    }
    const all = await dutyTable.getAllDayRecords();
    const rec = all.find((r) => r.recordId === subPending.recordId);
    if (!rec || rec.status || rec.name !== subPending.leaveName) {
      // 班次已被改（管理员动表/已请假）→ 双会话清掉，请假人重新办理
      state.mutate((s) => {
        if (s.pendingSubstitutes) delete s.pendingSubstitutes[subOpenId];
        if (s.pendingLeaves && s.pendingLeaves[still.leaveOpenId]) delete s.pendingLeaves[still.leaveOpenId].substitute;
      });
      return { handled: true, reply: '该班次已有变化（状态变更或人员调整），本次代班未生效。请让请假人重新办理请假。' };
    }
    const subMember = roster.findByOpenId(subOpenId);
    if (!subMember) {
      state.mutate((s) => { if (s.pendingSubstitutes) delete s.pendingSubstitutes[subOpenId]; });
      return { handled: true, reply: '名册中找不到你的记录（可能未绑定），无法完成代班。请先让请假人指定其他人。' };
    }
    // 冲突提示（提示但放行，2026-11-16 口径）：代班人自己当天同日还有其他班时在回执里提示
    const ownSameDay = all.filter((r) => r.recordId !== rec.recordId && r.name === subMember.name && r.dateStr === rec.dateStr && !r.status);
    const conflictNote = ownSameDay.length
      ? `\n⚠️ 注意：你当天排班里还有其他岗（${ownSameDay.map((r) => r.position).join('、')}），请合理安排时间。`
      : '';
    await dutyTable.updateAssignee(rec.recordId, { name: subMember.name, openId: subOpenId });
    const { penalty } = compensation.handleAbsence(subPending.leaveName, subPending.dateStr, config.status.LEAVE);
    plaza.append({ event: '值日代班', title: `${subMember.name} 代 ${subPending.leaveName}（${subPending.position}，${subPending.dateStr}）` });
    state.mutate((s) => {
      if (s.pendingSubstitutes) delete s.pendingSubstitutes[subOpenId];
      if (s.pendingLeaves) delete s.pendingLeaves[still.leaveOpenId];
    });
    const toSub = [
      `✅ 已确认代班：${subPending.dateStr}（${subPending.position}）的班已转为你正常值日。`,
      '职责与打卡验收同正常值日：完成后私信回复「打卡」并上传照片。',
      conflictNote,
      penalty ? '\nℹ️ 请假人已连续两次缺勤/请假，其补偿安排会含加罚批次。' : '',
    ].filter(Boolean).join('\n');
    const toLeave = `✅ ${subMember.name} 已确认代班：${subPending.dateStr}（${subPending.position}）的班转为其正常值日，你的下周补偿已按口径登记。`;
    bot.sendTextToUser(still.leaveOpenId, toLeave).catch((err) => console.error('[代班] 请假人回执失败:', err.message));
    return { handled: true, reply: toSub };
  });
}

/** 「拒绝代班」：清代班会话+请假人侧标记，通知请假人可再指定（pendingLeaves 保留） */
function rejectSubstitute(subOpenId) {
  const subPending = pendingSubOf(subOpenId);
  if (!subPending) {
    return { handled: true, reply: '没有待你确认的代班请求。' };
  }
  const subMember = roster.findByOpenId(subOpenId);
  const subName = subMember ? subMember.name : '对方';
  state.mutate((s) => {
    if (s.pendingSubstitutes) delete s.pendingSubstitutes[subOpenId];
    const p = s.pendingLeaves && s.pendingLeaves[subPending.leaveOpenId];
    if (p && p.substitute) {
      p.subRound = (p.subRound || 0) + 1; // 本轮记数（requestSubstitute 用它限轮次）
      delete p.substitute;
      p.askedAt = new Date().toISOString(); // 刷新请假会话 TTL，给请假人新的 10 分钟动作窗
    }
  });
  const roundsLeft = MAX_ROUNDS - ((state.load().pendingLeaves?.[subPending.leaveOpenId] || {}).subRound || 0);
  const leaveHint = roundsLeft > 0
    ? `可回复「确认请假 姓名」再指定一人（还可指定 ${roundsLeft} 轮），或回复「确认请假」直接走补偿安排。`
    : '代班指定次数已用完，回复「确认请假」直接走补偿安排。';
  bot.sendTextToUser(subPending.leaveOpenId, `你的代班请求被 ${subName} 婉拒（${subPending.dateStr} ${subPending.position}）。${leaveHint}`).catch((err) => console.error('[代班] 拒绝通知失败:', err.message));
  return { handled: true, reply: '已退回代班请求。' };
}

/** 超时清扫（cron 挂载）：代班请求超时=视为婉拒，刷新请假会话 TTL 并通知请假人 */
async function sweepSubstituteTimeouts() {
  const s = state.load();
  const subs = s.pendingSubstitutes || {};
  const expired = Object.entries(subs).filter(([, p]) => Date.now() - Date.parse(p.askedAt) > TTL_MS);
  if (!expired.length) return { swept: 0 };
  for (const [subOpenId, p] of expired) {
    const subMember = roster.findByOpenId(subOpenId);
    const subName = subMember ? subMember.name : '对方';
    state.mutate((st) => {
      if (st.pendingSubstitutes) delete st.pendingSubstitutes[subOpenId];
      const lp = st.pendingLeaves && st.pendingLeaves[p.leaveOpenId];
      if (lp && lp.substitute) {
        lp.subRound = (lp.subRound || 0) + 1;
        delete lp.substitute;
        lp.askedAt = new Date().toISOString(); // 刷新请假会话 TTL（动作窗与通知一致）
    
      }
    });
    const lp2 = state.load().pendingLeaves?.[p.leaveOpenId];
    const roundsLeft = MAX_ROUNDS - ((lp2 || {}).subRound || 0);
    const leaveHint = roundsLeft > 0
      ? `可回复「确认请假 姓名」再指定一人（还可指定 ${roundsLeft} 轮），或回复「确认请假」直接走补偿安排。`
      : '代班指定次数已用完，回复「确认请假」直接走补偿安排。';
    try {
      await bot.sendTextToUser(p.leaveOpenId, `你的代班请求（${p.dateStr} ${p.position}）超时未获 ${subName} 回执。${leaveHint}`);
    } catch (err) {
      console.error('[代班] 超时通知失败:', err.message);
    }
  }
  return { swept: expired.length };
}

/** 「取消请假」联动：清掉挂在请假人名下的代班确认会话（代班人不再等回执） */
function cancelByLeaveOpenId(leaveOpenId) {
  state.mutate((s) => {
    if (!s.pendingSubstitutes) return;
    for (const [subOpenId, p] of Object.entries(s.pendingSubstitutes)) {
      if (p.leaveOpenId === leaveOpenId) delete s.pendingSubstitutes[subOpenId];
    }
  });
}

module.exports = { requestSubstitute, confirmSubstitute, rejectSubstitute, sweepSubstituteTimeouts, cancelByLeaveOpenId };
