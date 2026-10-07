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
// 时长口径（本仓核心，2026-10-07 曼波定"每周统计打卡时长"）：
//   按人按上海挂钟日聚合，单日打卡 ≥2 条记「末卡 − 首卡」为当日时长，
//   恰 1 条记 0 并标「孤条」（无法界定时长），0 条=缺勤不在日明细出现。
//   周时长 = Σ当日时长。平台侧考勤组/班次只影响 ZKLink 自己的报表口径，
//   不影响本口径（跨班次通宵打卡按挂钟日切断，边界日各算各的）。
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
 * 名单外出现的 userid 以原始 userid 展示并标 unknown；名单内整周无记录的人也列出
 * （打卡天数 0），便于一眼看到缺勤。
 */
function aggregateDuration(records, members) {
  const nameMap = new Map((members || []).map((m) => [m.userid, m.name || m.userid]));
  const byUser = new Map();
  const sorted = [...(records || [])].sort((a, b) => a.checkin_time - b.checkin_time);

  for (const r of sorted) {
    const t = r.checkin_time * 1000;
    const day = fmtDay(toWall(t));
    if (!byUser.has(r.userid)) {
      byUser.set(r.userid, {
        userid: r.userid,
        name: nameMap.get(r.userid) || r._name || r.userid,
        known: nameMap.has(r.userid),
        days: new Map(), // dayKey -> {first, last, count}
        punches: 0,
      });
    }
    const u = byUser.get(r.userid);
    u.punches += 1;
    const d = u.days.get(day);
    if (!d) u.days.set(day, { first: t, last: t, count: 1 });
    else { d.last = t; d.count += 1; } // sorted 保证 last 单调
  }

  // 名单内整周无记录的人也列出来（打卡天数 0），便于负责人一眼看到缺勤
  for (const m of members || []) {
    if (!byUser.has(m.userid)) {
      byUser.set(m.userid, { userid: m.userid, name: m.name || m.userid, known: true, days: new Map(), punches: 0 });
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
        durationMs: d.count >= 2 ? d.last - d.first : 0,
        lonely: d.count < 2, // 孤条：当日仅 1 条打卡，时长不可界定
      }));
    const totalMs = days.reduce((s, d) => s + d.durationMs, 0);
    return {
      userid: u.userid,
      name: u.name,
      known: u.known,
      punchDays: days.length,
      punches: u.punches,
      lonelyDays: days.filter((d) => d.lonely).length,
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
    totalMs: users.reduce((s, u) => s + u.totalMs, 0),
  };
  // 日明细平铺（CSV 渲染复用）
  const dayRows = users.flatMap((u) => u.days.map((d) => ({ name: u.name, userid: u.userid, ...d })));

  return { users, totals, dayRows, recordCount: sorted.length, rawRecords: sorted, userNames: nameMap };
}

// 卡片 markdown 段（飞书卡片 markdown tag 逐人一行，同 duty/wecom 卡片口径）
function renderUserLines(agg, opts = {}) {
  const maxUserLines = opts.maxUserLines || 40;
  const users = agg.users || [];
  const lines = users.map((u) => {
    const lonely = u.lonelyDays ? ` · 孤条 ${u.lonelyDays} 天` : '';
    return `**${u.name}**：${u.punchDays} 天 · **${fmtDuration(u.totalMs)}**${lonely}`;
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
  const head = ['姓名', 'userid', '日期', '星期', '首卡', '末卡', '打卡条数', '当日时长'];
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
  fmtDuration,
  renderUserLines,
  renderCsv,
  fmtDay,
  fmtTime,
  fmtClock,
  weekdayCN,
};
