// ============================================================
// 周窗口与打卡时长聚合（纯函数，无 IO，桩测试直接覆盖）
//
// 时区口径：中国无夏令时，上海时间 = UTC+8 恒定偏移。
// 实现手法：把时间戳 +8h 后当 UTC 读，得到"上海挂钟"分量；
// 算完挂钟再 -8h 还原成真实时刻。
//
// 播报窗口：以「发送日」为锚——窗口 = 发送日 00:00 往前整 7 天。
// 默认每周一 09:30 发，窗口即上一周一 00:00 ~ 本周一 00:00（上一完整周）。
//
// 时长口径（本仓核心；2026-10-07 定"每周统计打卡时长"，2026-10-18 曼波定平台口径）：
//   - feishu 档（生产）：以飞书考勤「打卡结果」user_tasks 的上下班配对为准——
//     平台按班次把上班卡/下班卡配成班段，工作日边界 06:00（06:00–次日 05:59），
//     跨天班次计入起始日；同一天多个班段逐段累加；单边卡标缺卡、不计时长
//     （NoNeedCheck 单边卡不算缺卡）。aggregateSessions 消费该口径。
//   - import/http 档：保留旧流水两两配对（第1→第2、第3→第4…）——按上海挂钟日切断、
//     奇数末张落单不计、恰 1 条孤条计 0。aggregateDuration 消费该口径。
//   两种口径由 agg.mode 区分（'sessions' / 'pairs'），卡片/CSV/云文档据此分支。
// ============================================================

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const WEEKDAYS_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function toWall(ms) {
  return ms + SHANGHAI_OFFSET_MS;
}

function fromWall(wallMs) {
  return wallMs - SHANGHAI_OFFSET_MS;
}

// 某时刻（真实毫秒）对应的上海当日 00:00 的真实毫秒
function shanghaiMidnight(ms) {
  const d = new Date(toWall(ms));
  return fromWall(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function shanghaiDayOfWeek(ms) {
  return new Date(toWall(ms)).getUTCDay(); // 0=周日
}

function fmtDay(wallMs) {
  return new Date(wallMs).toISOString().slice(0, 10);
}

function fmtTime(realMs) {
  const d = new Date(toWall(realMs));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fmtClock(realMs) {
  const d = new Date(toWall(realMs));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function weekdayCN(realMs) {
  return WEEKDAYS_CN[shanghaiDayOfWeek(realMs)];
}

// 毫秒 → 「X小时Y分」（<1 分钟显示 0；负值按 0 处理防脏数据出负时长）
function fmtDuration(ms) {
  const mins = Math.max(0, Math.floor((Number(ms) || 0) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}分钟`;
  return m ? `${h}小时${m}分钟` : `${h}小时`;
}

// 「发送日 DHH:MM」体系下，now 所在周期最近的发送日 00:00（上海挂钟）
// sendDow: 0~6（0=周日）；now 已过本周发送日则锚=本周发送日，否则=上周发送日
function currentAnchor(nowMs, sendDow) {
  const todayMidnight = shanghaiMidnight(nowMs);
  const daysAgo = (shanghaiDayOfWeek(nowMs) - sendDow + 7) % 7;
  return todayMidnight - daysAgo * DAY_MS;
}

// 周报窗口：offset=0 表示 now 所在周期应播报的那一周（最近一个已结束的发送周期），
// offset 每加 1 往前推一周。返回 {start, end(真实 Date 毫秒), label, key, startWall, endWall}
function weekWindow(offset = 0, nowMs = Date.now(), sendDow = 1) {
  const anchorWall = toWall(currentAnchor(nowMs, sendDow)) - offset * 7 * DAY_MS;
  const startWall = anchorWall - 7 * DAY_MS;
  const endWall = anchorWall;
  return {
    start: fromWall(startWall),
    end: fromWall(endWall),
    startWall,
    endWall,
    label: `${fmtDay(startWall)} ~ ${fmtDay(endWall - DAY_MS)}`,
    key: fmtDay(startWall), // 周唯一键=该周周一日期，播报/留档去重用
  };
}

// 判断 now 是否已过「发送日 D 的 HH:MM」（用于重启补发判定）
function isPastSendTime(nowMs, sendDow, hour, minute) {
  const anchorReal = currentAnchor(nowMs, sendDow);
  return nowMs >= anchorReal + (hour * 60 + minute) * 60 * 1000;
}

// 下一次发送时刻（真实毫秒）：上海挂钟下最近的 sendDow hour:minute，已过则 +7 天
function nextSendTime(nowMs, sendDow, hour, minute) {
  const daysAhead = (sendDow - shanghaiDayOfWeek(nowMs) + 7) % 7;
  let t = shanghaiMidnight(nowMs) + daysAhead * DAY_MS + (hour * 60 + minute) * 60 * 1000;
  if (t <= nowMs) t += 7 * DAY_MS;
  return t;
}

/**
 * 打卡时长聚合（记录流 {userid, _name?, checkin_time(秒)}，名单 [{userid,name}]）
 * 时长口径：当日打卡顺序两两配对求和，每卡最多当一次节点，落单卡不计（leftover）。
 * 名单外出现的 userid 以原始 userid 展示并标 unknown；名单内整周无记录的人也列出
 * （打卡天数 0），便于一眼看到缺勤。
 */
function aggregateDuration(records, members) {
  // memberMap 保留 openId（bitable 人员字段归档用，2026-10-12 名单源带出）
  const memberMap = new Map((members || []).map((m) => [m.userid, m]));
  const byUser = new Map();
  const sorted = [...(records || [])].sort((a, b) => a.checkin_time - b.checkin_time);

  for (const r of sorted) {
    const t = r.checkin_time * 1000;
    const day = fmtDay(toWall(t));
    if (!byUser.has(r.userid)) {
      const m = memberMap.get(r.userid);
      byUser.set(r.userid, {
        userid: r.userid,
        name: (m && m.name) || r._name || r.userid,
        openId: (m && m.openId) || '',
        known: memberMap.has(r.userid),
        days: new Map(), // dayKey -> {first, last, count}
        punches: 0,
      });
    }
    const u = byUser.get(r.userid);
    u.punches += 1;
    const d = u.days.get(day);
    if (!d) u.days.set(day, { first: t, last: t, count: 1, openFrom: t, durationMs: 0 });
    // 配对状态机：openFrom=等待配对的落单卡时刻；新卡闭合一段后两卡各消费一次
    else if (d.openFrom == null) { d.last = t; d.count += 1; d.openFrom = t; }
    else { d.last = t; d.count += 1; d.durationMs += t - d.openFrom; d.openFrom = null; } // sorted 保证 last 单调
  }

  // 名单内整周无记录的人也列出来（打卡天数 0），便于负责人一眼看到缺勤
  for (const m of members || []) {
    if (!byUser.has(m.userid)) {
      byUser.set(m.userid, { userid: m.userid, name: m.name || m.userid, openId: m.openId || '', known: true, days: new Map(), punches: 0 });
    }
  }

  const users = [...byUser.values()].map((u) => {
    const days = [...u.days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, d]) => ({
        day,
        first: d.first,
        last: d.last,
        count: d.count,
        durationMs: d.durationMs,
        lonely: d.count < 2, // 孤条：当日仅 1 条打卡，无配对可言
        // 落单卡：奇数张时末张未参与配对（孤条日由 lonely 表达，不重复计）
        leftover: d.openFrom != null && d.count >= 2 ? 1 : 0,
      }));
    const totalMs = days.reduce((s, d) => s + d.durationMs, 0);
    return {
      userid: u.userid,
      name: u.name,
      openId: u.openId || '',
      known: u.known,
      punchDays: days.length,
      punches: u.punches,
      lonelyDays: days.filter((d) => d.lonely).length,
      leftoverCards: days.reduce((s, d) => s + d.leftover, 0),
      totalMs,
      days,
    };
  });
  users.sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));

  const totals = {
    punches: users.reduce((s, u) => s + u.punches, 0),
    users: users.length,
    punchUsers: users.filter((u) => u.punches > 0).length,
    lonelyDays: users.reduce((s, u) => s + u.lonelyDays, 0),
    leftoverCards: users.reduce((s, u) => s + (u.leftoverCards || 0), 0),
    totalMs: users.reduce((s, u) => s + u.totalMs, 0),
  };
  // 日明细平铺（CSV 渲染复用）
  const dayRows = users.flatMap((u) => u.days.map((d) => ({ name: u.name, userid: u.userid, ...d })));

  return { mode: 'pairs', users, totals, dayRows, recordCount: sorted.length, rawRecords: sorted, userNames: memberMap };
}

/**
 * 平台班段聚合（飞书 user_tasks 口径，2026-10-18 曼波定）：
 * 平台已按班次配对上下班卡（工作日 06:00–次日 05:59，跨天班次计入起始日），
 * 本函数只做按人/按平台 day 的累加，不再自行配对；同一天多个班段逐段相加。
 * 单边卡（missing=true）标缺卡、不计时长；NoNeedCheck 单边卡由抓取侧标 missing=false。
 * @param {Array<{userid, _name, day, checkin_time, checkout_time, durationMs, complete, missing, crossDay}>} sessions
 * @param {Array<{userid, name, openId?}>} members
 */
function aggregateSessions(sessions, members) {
  const memberMap = new Map((members || []).map((m) => [m.userid, m]));
  const byUser = new Map();

  for (const s of sessions || []) {
    if (!s || !s.userid) continue;
    const m = memberMap.get(s.userid);
    if (!byUser.has(s.userid)) {
      byUser.set(s.userid, {
        userid: s.userid,
        name: (m && m.name) || s._name || s.userid,
        openId: (m && m.openId) || '',
        known: memberMap.has(s.userid),
        days: new Map(),
        punches: 0,
        sessions: 0,
        completeSessions: 0,
        missingSessions: 0,
      });
    }
    const u = byUser.get(s.userid);
    const day = String(s.day || '');
    const times = [s.checkin_time, s.checkout_time]
      .filter((t) => t != null && Number.isFinite(Number(t)))
      .map((t) => Number(t));
    if (times.length === 0) continue; // 无打卡记录的排班段不进入日明细
    if (!u.days.has(day)) {
      u.days.set(day, { first: null, last: null, count: 0, durationMs: 0, sessions: 0, completeSessions: 0, missingSessions: 0 });
    }
    const d = u.days.get(day);
    const ms = times.map((t) => t * 1000);
    u.punches += times.length;
    u.sessions += 1;
    d.count += times.length;
    d.sessions += 1;
    if (d.first == null || Math.min(...ms) < d.first) d.first = Math.min(...ms);
    if (d.last == null || Math.max(...ms) > d.last) d.last = Math.max(...ms);
    if (s.complete) {
      u.completeSessions += 1;
      d.completeSessions += 1;
      d.durationMs += Math.max(0, Number(s.durationMs) || 0);
    } else if (s.missing !== false) {
      u.missingSessions += 1;
      d.missingSessions += 1;
    }
  }

  // 名单内整周无记录的人也列出（0 天 / 0 时长），便于一眼看到缺勤
  for (const m of members || []) {
    if (!byUser.has(m.userid)) {
      byUser.set(m.userid, {
        userid: m.userid,
        name: m.name || m.userid,
        openId: m.openId || '',
        known: true,
        days: new Map(),
        punches: 0,
        sessions: 0,
        completeSessions: 0,
        missingSessions: 0,
      });
    }
  }

  const users = [...byUser.values()].map((u) => {
    const days = [...u.days.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, d]) => ({
        day,
        first: d.first,
        last: d.last,
        count: d.count,
        durationMs: d.durationMs,
        sessions: d.sessions,
        completeSessions: d.completeSessions,
        missingSessions: d.missingSessions,
        lonely: false,
        leftover: 0,
      }));
    const totalMs = days.reduce((sum, d) => sum + d.durationMs, 0);
    return {
      userid: u.userid,
      name: u.name,
      openId: u.openId || '',
      known: u.known,
      punchDays: days.length,
      punches: u.punches,
      sessions: u.sessions,
      completeSessions: u.completeSessions,
      missingSessions: u.missingSessions,
      lonelyDays: 0,
      leftoverCards: 0,
      totalMs,
      days,
    };
  });
  users.sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0));

  const totals = {
    mode: 'sessions',
    punches: users.reduce((n, u) => n + u.punches, 0),
    users: users.length,
    punchUsers: users.filter((u) => u.punches > 0).length,
    sessions: users.reduce((n, u) => n + u.sessions, 0),
    completeSessions: users.reduce((n, u) => n + u.completeSessions, 0),
    missingSessions: users.reduce((n, u) => n + u.missingSessions, 0),
    lonelyDays: 0,
    leftoverCards: 0,
    totalMs: users.reduce((n, u) => n + u.totalMs, 0),
  };
  const dayRows = users.flatMap((u) => u.days.map((d) => ({ name: u.name, userid: u.userid, ...d })));
  return { mode: 'sessions', users, totals, dayRows, recordCount: (sessions || []).length, rawRecords: sessions || [], userNames: memberMap };
}

// 卡片 markdown 段（飞书卡片 markdown tag 逐人一行，同 duty/wecom 卡片口径）
function renderUserLines(agg, opts = {}) {
  const maxUserLines = opts.maxUserLines || 40;
  const mode = agg.mode || 'pairs';
  const users = agg.users || [];
  const lines = users.map((u) => {
    if (mode === 'sessions') {
      const missing = u.missingSessions ? ` · 缺卡 ${u.missingSessions} 段` : '';
      return `**${u.name}**：${u.punchDays} 天 · **${fmtDuration(u.totalMs)}**${missing}`;
    }
    const lonely = u.lonelyDays ? ` · 孤条 ${u.lonelyDays} 天` : '';
    const leftover = u.leftoverCards ? ` · 落单 ${u.leftoverCards} 卡` : '';
    return `**${u.name}**：${u.punchDays} 天 · **${fmtDuration(u.totalMs)}**${lonely}${leftover}`;
  });
  const shown = lines.slice(0, maxUserLines);
  if (lines.length > shown.length) shown.push(`…其余 ${lines.length - shown.length} 人见云文档留档`);
  return shown;
}

function csvEscape(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = `'` + s; // 公式注入防护：Excel/WPS 把 =+-@ 开头单元格当公式执行
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV 日明细（UTF-8 BOM 头，Excel 直开不乱码）
function renderCsv(win, agg) {
  const mode = agg.mode || 'pairs';
  const head = mode === 'sessions'
    ? ['姓名', 'userid', '日期', '星期', '首卡', '末卡', '打卡条数', '当日时长', '缺卡']
    : ['姓名', 'userid', '日期', '星期', '首卡', '末卡', '打卡条数', '当日时长', '落单卡'];
  const rows = [head.join(',')];
  for (const d of agg.dayRows || []) {
    rows.push([
      d.name,
      d.userid,
      d.day,
      weekdayCN(d.first),
      fmtClock(d.first),
      fmtClock(d.last),
      d.count,
      fmtDuration(d.durationMs),
      mode === 'sessions' ? (d.missingSessions || 0) : (d.leftover ? 1 : 0),
    ].map(csvEscape).join(','));
  }
  if (rows.length === 1) rows.push('（本周无打卡记录）,,,,,,,,');
  return '\uFEFF' + rows.join('\r\n');
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  DAY_MS,
  weekWindow,
  currentAnchor,
  isPastSendTime,
  nextSendTime,
  aggregateDuration,
  aggregateSessions,
  fmtDuration,
  renderUserLines,
  renderCsv,
  fmtDay,
  fmtTime,
  fmtClock,
  weekdayCN,
};
