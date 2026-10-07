// ============================================================
// 打卡明细导入（数据源 import：ZKLink 网页端考勤组维度导出，人肉周导上传）
//
// ZKLink（zklink.zktecoiot.com）网页端 → 考勤 → 打卡记录（Clocking Records）
// 按考勤组导出 xlsx/csv → POST /api/attendance/import 上传，本模块解析为
// 统一记录流（{userid, _name, checkin_time(秒), checkin_type, exception_type,
// location_title, wifiname, groupname}），列名按常见表头模糊匹配，匹配不到的
// 列忽略并在结果里报告（平台改导出模板时一眼看出缺哪列）。
//
// 时间列三种形态都认（首行数据嗅探定模式）：
//   ① 单列完整时间（"2026/10/5 08:55" / Date 单元格 / Excel 序列号）
//   ② 「日期 + 时间」两列分列（"2026/10/5" + "08:55"，ZKLink 导出常见）
//   ③ 多个时间列（上下班分列的「日报/统计」模板）→ 明确报错挡下
//     （静默丢下班记录是真实事故路径，wecom-attendance-bot 2026-09-16 同款教训）
//
// 时区口径与 report.js 一致：上海时间 = UTC+8 恒定偏移。
// ============================================================

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

// 表头模糊匹配（小写包含）；顺序=优先级，命中即用
const COLUMN_HINTS = {
  name: ['姓名', '名字', 'name', '人员名称', '成员'],
  userid: ['工号', '人员编号', '编号', '账号', 'userid', 'user_id'],
  date: ['考勤日期', '日期', 'date'],
  time: ['打卡时间', '时间', 'time'],
  checkin_type: ['打卡状态', '打卡方式', '打卡类型', '状态', '类型', 'type'],
  exception_type: ['异常', 'exception'],
  location_title: ['打卡地点', '地点', '设备', '位置', 'location'],
  wifiname: ['wifi', '无线'],
  groupname: ['考勤组', '规则', '分组', 'group'],
};
const REQUIRED = ['name']; // time/date 组合在下面单独校验

function matchColumns(headers) {
  const lower = headers.map((h) => String(h || '').trim().toLowerCase());
  const map = {};
  const matched = [];
  for (const [field, hints] of Object.entries(COLUMN_HINTS)) {
    for (const hint of hints) {
      const idx = lower.findIndex((h) => h && h.includes(hint.toLowerCase()));
      if (idx >= 0) { map[field] = idx; matched.push(`${field}←"${headers[idx]}"`); break; }
    }
  }
  // 多时间列防呆（「日期」列不计入）：像「上班时间/下班时间」分列的日报/统计模板
  // 会静默丢列（真事故路径，wecom-attendance-bot 2026-09-16 同款教训），必须挡下
  const timeHints = COLUMN_HINTS.time;
  const dateIdx = map.date;
  const timeCols = [];
  lower.forEach((h, idx) => {
    if (h && idx !== dateIdx && timeHints.some((t) => h.includes(t.toLowerCase()))) timeCols.push(idx);
  });
  return { map, matched, timeCols };
}

// 「日期」单元格 → 上海挂钟当日 00:00 的真实毫秒；解析不出返回 null
function toShanghaiDayMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    const d = v;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - SHANGHAI_OFFSET_MS;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return Math.round((v - 25569) * DAY_MS) - SHANGHAI_OFFSET_MS;
  }
  const m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(String(v).trim());
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) - SHANGHAI_OFFSET_MS;
  return null;
}

// 「时间」单元格 → 当日 0 点起的毫秒偏移（"8:55" / "08:55:00" / Date / 序列号小数）；解析不出返回 null
function toShanghaiTimeOfDayMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    const d = v;
    return (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) * 1000;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const frac = v - Math.floor(v); // 序列号小数=当日时刻
    return Math.round(frac * DAY_MS);
  }
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(String(v).trim());
  if (m) return (+m[1] * 3600 + +m[2] * 60 + +(m[3] || 0)) * 1000;
  return null;
}

// 完整时间单元格 → 上海挂钟毫秒：Date 对象（xlsx cellDates 视序列号为 UTC，
// 即 Date 的 UTC 分量=上海挂钟分量）/ Excel 序列号 / 常见字符串
function toShanghaiMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    const d = v;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) - SHANGHAI_OFFSET_MS;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return Math.round((v - 25569) * DAY_MS) - SHANGHAI_OFFSET_MS;
  }
  const m = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(String(v).trim());
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) - SHANGHAI_OFFSET_MS;
  }
  return null;
}

// 值嗅探：该单元格像「仅时间」（HH:MM 开头且不带日期）
function looksTimeOnly(v) {
  return v != null && typeof v !== 'object' && !/^\s*\d{4}[-/年]/.test(String(v)) && toShanghaiTimeOfDayMs(v) != null;
}

/**
 * 解析打卡明细工作簿（xlsx/csv 字节流）
 * @returns {{records: Array, members: Array, matched: string[], skipped: number, rows: number}}
 */
function parseWorkbook(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('工作簿中没有工作表');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (!rows.length) throw new Error('工作表为空');
  // 表头行=第一个含「时间/日期」类表头的行（有些导出前几行是标题/筛选说明）
  let headerIdx = rows.findIndex((r) => r.some((c) => /打卡时间|时间|日期|time|date/i.test(String(c))));
  if (headerIdx === -1) headerIdx = 0;
  const headers = rows[headerIdx].map((c) => String(c));
  const { map, matched, timeCols } = matchColumns(headers);
  const missing = REQUIRED.filter((f) => map[f] == null);
  if (missing.length) {
    throw new Error(`报表缺关键列：${missing.join('/')}（识别到的列：${matched.join('、') || '无'}；全部表头：${headers.filter(Boolean).join(' | ').slice(0, 200)}）`);
  }
  if (timeCols.length > 1) {
    throw new Error(`检测到 ${timeCols.length} 个时间列（${timeCols.map((i) => headers[i]).join('、')}）——像是「打卡日报/统计」模板。请导出「打卡记录明细」模板（每行一次打卡，或「日期+时间」两列）后重试`);
  }

  // 时间来源定模式：
  //   date 列存在 + time 列存在 + time 列数据像仅时间 → 分列组合；
  //   time 列数据是完整时间（或无 date 列）→ 单列模式（time 列即完整时间）
  const dataRows = rows.slice(headerIdx + 1).filter((r) => r && r.some((c) => String(c).trim() !== ''));
  let mode = 'single';
  if (map.date != null && map.time != null && dataRows.length) {
    const firstTime = dataRows.find((r) => String(r[map.time] ?? '').trim() !== '');
    if (firstTime && looksTimeOnly(firstTime[map.time])) mode = 'split';
  }
  if (mode === 'single' && map.time == null) {
    throw new Error(`报表缺时间列：需要「打卡时间」单列或「日期+时间」两列（识别到的列：${matched.join('、') || '无'}；全部表头：${headers.filter(Boolean).join(' | ').slice(0, 200)}）`);
  }

  const records = [];
  let skipped = 0;
  for (const row of dataRows) {
    let ms = null;
    if (mode === 'split') {
      const dayMs = toShanghaiDayMs(row[map.date]);
      const todMs = toShanghaiTimeOfDayMs(row[map.time]);
      if (dayMs != null && todMs != null) ms = dayMs + todMs;
    } else {
      ms = toShanghaiMs(row[map.time]);
    }
    let name = map.name != null ? String(row[map.name] || '').trim() : '';
    const useridCell = map.userid != null ? String(row[map.userid] || '').trim() : '';
    if (!ms || (!name && !useridCell)) { skipped += 1; continue; } // 有时间但姓名账号全空：合并单元格续行，跳过防幽灵用户
    if (!name && useridCell) { name = useridCell; }
    const userid = useridCell || name;
    const str = (f) => (map[f] != null ? String(row[map[f]] || '').trim() : '');
    records.push({
      userid,
      _name: name || userid,
      checkin_time: Math.floor(ms / 1000),
      checkin_type: str('checkin_type'),
      exception_type: str('exception_type'),
      location_title: str('location_title'),
      wifiname: str('wifiname'),
      groupname: str('groupname'),
    });
  }
  if (!records.length) throw new Error(`解析到 0 条打卡记录（表头识别：${matched.join('、') || '无'}，时间模式：${mode}）`);
  return { records, members: deriveMembers(records), matched, skipped, rows: dataRows.length };
}

/** 从记录流取名单（去重） */
function deriveMembers(records) {
  const seen = new Map();
  for (const r of records || []) {
    if (!seen.has(r.userid)) seen.set(r.userid, { userid: r.userid, name: r._name || r.userid });
  }
  return [...seen.values()];
}

/** 名单合并：既有名册优先（保留手工维护的 userid↔姓名），导入衍生的新成员追加 */
function mergeMembers(roster, derived) {
  const byId = new Map((roster || []).map((m) => [m.userid, m]));
  for (const m of derived || []) {
    if (!byId.has(m.userid)) byId.set(m.userid, m);
  }
  return [...byId.values()];
}

/** 过滤落在播报窗口 [start, end) 内的记录 */
function filterByWindow(records, win) {
  return (records || []).filter((r) => r.checkin_time * 1000 >= win.start && r.checkin_time * 1000 < win.end);
}

module.exports = { parseWorkbook, deriveMembers, mergeMembers, filterByWindow, toShanghaiMs, toShanghaiDayMs, toShanghaiTimeOfDayMs };
