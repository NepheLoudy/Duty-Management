// ============================================================
// 日期工具：全部按 Asia/Shanghai 墙上时钟（固定 UTC+8，无夏令时）。
// 排班日期一律用「YYYY-MM-DD」字符串作为键；写入多维表格日期字段时
// 转成上海当天 0 点的毫秒时间戳，读回时同样按 +8 取日期串，两端自洽。
// ============================================================

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 上海墙上时钟 parts（用加 8 小时后的 UTC 取值读） */
function shanghaiParts(input = new Date()) {
  const ms = input instanceof Date ? input.getTime() : Number(input);
  const shifted = new Date(ms + TZ_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return {
    y, m, d,
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    dateStr: formatDateStr(y, m, d),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function formatDateStr(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 任意输入（Date/毫秒/已格式化串）→ 上海日期串 YYYY-MM-DD */
function toDateStr(input) {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  return shanghaiParts(input).dateStr;
}

/** 上海日期串 → 上海当天 0 点的毫秒时间戳（多维表格日期字段写入值） */
function shanghaiMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0) - TZ_OFFSET_MS;
}

/** 上海日期串 + n 天 → 新日期串 */
function addDays(dateStr, n) {
  return shanghaiParts(shanghaiMidnightMs(dateStr) + n * 24 * 60 * 60 * 1000).dateStr;
}

/** a - b 的天数差（都是上海日期串） */
function diffDays(aStr, bStr) {
  return Math.round((shanghaiMidnightMs(aStr) - shanghaiMidnightMs(bStr)) / (24 * 60 * 60 * 1000));
}

/** 所在自然周（周一为一周起点）的日期串 */
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(dateStr, -back);
}

/** 日历月加减（月末溢出时向月末收敛，如 1-31 减一月 → 2-28/2-29） */
function monthAdd(dateStr, n) {
  let [y, m, d] = dateStr.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return formatDateStr(y, m, Math.min(d, lastDay));
}

/** 今天（上海）日期串 */
function todayStr() {
  return shanghaiParts().dateStr;
}

module.exports = {
  TZ_OFFSET_MS,
  shanghaiParts,
  toDateStr,
  shanghaiMidnightMs,
  addDays,
  diffDays,
  mondayOf,
  monthAdd,
  todayStr,
};
