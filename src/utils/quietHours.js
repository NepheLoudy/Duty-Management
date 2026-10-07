const fs = require('fs');
const path = require('path');

// ============================================================
// 晚间静默（播报时段限制）——与 approval-bot 等仓通用实现同款
//
// 窗口 [QUIET_HOURS_START, QUIET_HOURS_END)（Asia/Shanghai，默认 02:00–09:00）
// 内，定时/自动播报不直接发送，统一积压到 end 整点冲刷补发。积压形态：
//   - task（gateTask）：可重扫的任务（中午提醒/次日提醒/当日询问/对账/提前预告等）
//     只登记名字+触发槽位，冲刷时重新执行整个任务函数——以补发时刻的最新
//     数据重查（「挤压要为挤压之后的事情负责」）；同名任务只保留最新槽位
//     （合并语义，防整点类任务在窗口内逐小时堆积、冲刷连发多遍）。
//   - payload（gatePayload）：一次性事件通知（收口回执等）原样落盘按序补发。
//
// 执行失败自动重试（2026-10-07 v47 新增，10-05 断网静默丢整轮提醒的事故复盘）：
//   非静默时段 gateTask 直跑失败（典型：主机连不上飞书 API 的 fetch failed）不再
//   静默丢弃——登记积压按递增间隔重试（1/2/4/8/15…15 分钟封顶，共 MAX_ATTEMPTS 次），
//   冲刷本身若落进静默窗口一律推迟到窗口结束（静默语义不因重试破例）；
//   重试耗尽转「待补报」失败记录，notifier（cron 注入的管理员私信）在确认网络
//   恢复的任务首次成功后补报，补报成功才清账。
//
// 积压持久化到项目根 .quiet-backlog.json：重启不丢。启动时已过 end 整点则
// 立即补冲刷，否则调度到 end 整点。冲刷失败的单条保留重试（至多 MAX_ATTEMPTS 次
// 尝试），超限转失败补报。
//
// 不受限：对话/指令回复（是/否/值日助手等交互回路）与人工当下主动触发
//（/api/bot/test-* 手动接口，含 dryRun）——操作者明确要求立即执行。
// 业务写表动作（收口置状态/算总状态/生成补偿义务）不延迟，只有通知发送过闸门。
// ============================================================

// 可用 QUIET_BACKLOG_FILE 挪到项目目录外（SFTP 部署会清空项目目录，部署即丢积压）
const BACKLOG_FILE = process.env.QUIET_BACKLOG_FILE || path.join(__dirname, '..', '..', '.quiet-backlog.json');
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai 无夏令时，固定 UTC+8
const FLUSH_ROUNDS = 10;

// 重试参数（惰性读 env：测试可调小；默认 1min 起指数退避至 15min 封顶、共 8 次尝试，
// 累计覆盖约 50 分钟——小时级断网靠重试耗尽后的管理员补报兜底）
function retryMaxAttempts() {
  return Math.max(1, parseInt(process.env.QUIET_RETRY_MAX_ATTEMPTS, 10) || 8);
}
function retryBaseMs() {
  const raw = parseInt(process.env.QUIET_RETRY_BASE_MS, 10);
  if (Number.isFinite(raw)) return Math.max(10, raw); // 显式配置才可低至毫秒级（桩测试用）
  return 60 * 1000;
}
function retryDelayMs(attempts) {
  return Math.min(retryBaseMs() * Math.pow(2, Math.max(0, attempts - 1)), 15 * 60 * 1000);
}

const settings = {
  enabled: process.env.QUIET_HOURS_DISABLED !== '1',
  start: clampHour(process.env.QUIET_HOURS_START, 2),
  end: clampHour(process.env.QUIET_HOURS_END, 9),
};

function clampHour(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim();
  // 兼容「HH:mm」格式（wecom-attendance 同名键口径）与纯小时数字：
  // 本模块粒度为整小时，分钟非 0 时取整点并 warn
  if (s.includes(':')) {
    const [h, m] = s.split(':').map((x) => Number(x));
    if (Number.isFinite(h) && Number.isFinite(m)) {
      if (m !== 0) console.warn(`[静默] QUIET_HOURS 含分钟（${s}），按整点 ${Math.trunc(h)} 处理`);
      return Math.min(23, Math.max(0, Math.trunc(h)));
    }
    console.warn(`[静默] QUIET_HOURS 无法解析（${s}），使用默认 ${fallback}`);
    return fallback;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) {
    console.warn(`[静默] QUIET_HOURS 无法解析（${s}），使用默认 ${fallback}`);
    return fallback;
  }
  return Math.min(23, Math.max(0, Math.trunc(n)));
}

/** 上海墙上时钟 parts（用加 8 小时后的 UTC 取值读） */
function shanghaiParts(now = new Date()) {
  const shifted = new Date(now.getTime() + TZ_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function inQuietHours(now = new Date()) {
  if (!settings.enabled || settings.start === settings.end) return false;
  const m = shanghaiParts(now).minutesOfDay;
  const s = settings.start * 60;
  const e = settings.end * 60;
  // 支持跨午夜写法（start > end，如 23→6）
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

/** 下一个 end 整点（上海）的绝对时间 */
function nextQuietEnd(now = new Date()) {
  const p = shanghaiParts(now);
  let target = Date.UTC(p.y, p.m, p.d, settings.end, 0, 0) - TZ_OFFSET_MS;
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000;
  return new Date(target);
}

function quietWindowDesc() {
  const fmt = (h) => `${String(h).padStart(2, '0')}:00`;
  return `${fmt(settings.start)}–${fmt(settings.end)}`;
}

/** 上海时区的 "YYYY-MM-DD HH:mm" 戳（cron 同槽位去重键用） */
function shanghaiStamp(now = new Date()) {
  const p = shanghaiParts(now);
  const shifted = new Date(now.getTime() + TZ_OFFSET_MS);
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${hh}:${mm}`;
}

// ---------- 积压队列（持久化，含失败补报账目） ----------

const runners = new Map(); // task 名 -> async 执行器（冲刷时重跑整个任务函数）
const payloadHandlers = {}; // payload 名 -> 补发处理器（一次性通知按序补发）
const failureNotifiers = []; // 失败补报器（cron 注入管理员私信；任一成功即清账）

let flushTimer = null;
let nextFlushAt = null;
let flushing = false;
let reporting = false;

/** 读积压文件（items=待冲刷积压，failures=重试耗尽的待补报失败记录） */
function readStore() {
  try {
    if (fs.existsSync(BACKLOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(BACKLOG_FILE, 'utf-8'));
      return {
        items: Array.isArray(data.items) ? data.items : [],
        failures: Array.isArray(data.failures) ? data.failures : [],
      };
    }
  } catch (err) {
    console.warn('[晚间静默] 读取积压文件失败（按空处理）:', err.message);
  }
  return { items: [], failures: [] };
}

function writeStore(items, failures) {
  try {
    if (items.length === 0 && failures.length === 0) {
      if (fs.existsSync(BACKLOG_FILE)) fs.unlinkSync(BACKLOG_FILE);
    } else {
      fs.writeFileSync(BACKLOG_FILE, JSON.stringify({ items, failures }, null, 2));
    }
  } catch (err) {
    console.warn('[晚间静默] 写积压文件失败（仅影响重启恢复）:', err.message);
  }
}

/** 兼容旧调用：只读写 items 侧，failures 原样保留 */
function loadBacklog() {
  return readStore().items;
}

function saveBacklog(items) {
  writeStore(items, readStore().failures);
}

function registerTask(name, fn) {
  runners.set(name, fn);
}

function registerPayloadHandler(name, fn) {
  payloadHandlers[name] = fn;
}

/**
 * 定时任务静默闸门：非静默直接执行；静默窗口内登记积压，冲刷时重跑整个 run。
 * 非静默直跑失败（典型：fetch failed 断网）→ 登记积压按递增间隔自动重试，
 * 不再静默丢弃整轮任务（2026-10-07 v47，10-05 断网事故复盘）。
 * @returns {Promise<{deferred: boolean}>} 实际结果或积压登记信息
 */
async function gateTask(name, fireKey, run, label = name) {
  if (!inQuietHours()) {
    try {
      const result = await run();
      // 成功 = 网络可用的证据点，顺手补报历史失败记录（异步，不阻塞主流程）
      maybeReportFailures().catch(() => {});
      return result;
    } catch (err) {
      registerRetry(name, fireKey, err, label);
      throw err; // cron 层照常打错误日志
    }
  }

  const { items, failures } = readStore();
  if (items.some((it) => it.type === 'task' && it.name === name && it.fireKey === fireKey)) {
    console.log(`[晚间静默] ${label} 该槽位已积压，跳过重复登记`);
    return { deferred: true, note: '已积压' };
  }
  // 可重扫任务的合并语义：同名任务只保留最新槽位——冲刷时重跑整个任务函数、
  // 以补发时刻最新数据重查，旧槽位的结果注定被覆盖（「挤压要为挤压之后的事情负责」）。
  // 否则每小时整点类任务（快递未取播报）在静默窗口逐小时各积压一条，09:00 冲刷
  // 同一清单连发 N 遍。
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'task' && items[i].name === name) items.splice(i, 1);
  }
  items.push({ type: 'task', name, fireKey, queuedAt: new Date().toISOString() });
  writeStore(items, failures);
  scheduleFlushFromGate();
  console.log(`[晚间静默] ${label} 落入积压（共 ${items.length} 条），${nextQuietEnd().toLocaleString('zh-CN')} 统一补跑`);
  return { deferred: true };
}

/** 执行失败登记重试：同名合并只留最新槽位；重试调度落进静默窗口则推迟到窗口结束 */
function registerRetry(name, fireKey, err, label) {
  const { items, failures } = readStore();
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === 'task' && items[i].name === name) items.splice(i, 1);
  }
  items.push({ type: 'task', name, fireKey, queuedAt: new Date().toISOString(), lastError: String((err && err.message) || err) });
  writeStore(items, failures);
  const delay = inQuietHours() ? Math.max(nextQuietEnd().getTime() - Date.now(), 1000) : retryBaseMs();
  scheduleFlush(delay);
  console.error(`[任务重试] ${label} 执行失败（${(err && err.message) || err}），已登记自动重试`);
}

/**
 * 一次性通知载荷闸门：非静默返回 false（调用方照常直接发送）；
 * 静默窗口内载荷落盘积压并返回 true（调用方跳过发送）。
 */
function gatePayload(name, payload, label = name) {
  if (!inQuietHours()) return false;
  const items = loadBacklog();
  items.push({ type: 'payload', name, payload, queuedAt: new Date().toISOString() });
  saveBacklog(items);
  scheduleFlushFromGate();
  console.log(`[晚间静默] ${label} 载荷落盘积压（共 ${items.length} 条），${nextQuietEnd().toLocaleString('zh-CN')} 统一补发`);
  return true;
}

async function runItem(item) {
  if (item.type === 'task') {
    const fn = runners.get(item.name);
    if (!fn) throw new Error(`任务「${item.name}」未注册冲刷执行器`);
    return fn();
  }
  const handler = payloadHandlers[item.name];
  if (!handler) throw new Error(`载荷「${item.name}」未注册补发处理器`);
  return handler(item.payload);
}

function describeItem(item) {
  if (item.type === 'task') return `${item.name}@${item.fireKey}`;
  return `${item.name}（${item.queuedAt}）`;
}

function scheduleFlush(delayMs) {
  if (flushTimer) clearTimeout(flushTimer);
  nextFlushAt = new Date(Date.now() + delayMs).toISOString();
  flushTimer = setTimeout(() => {
    flushTimer = null;
    nextFlushAt = null;
    runFlush().catch((err) => console.error('[晚间静默] 冲刷异常:', err.message));
  }, delayMs);
  if (flushTimer.unref) flushTimer.unref();
}

function scheduleFlushFromGate() {
  if (flushTimer) return; // 已有调度在等待，沿用
  scheduleFlush(Math.max(nextQuietEnd().getTime() - Date.now(), 1000));
}

async function runFlush() {
  if (flushing) return;
  flushing = true;
  try {
    // 防越窗兜底：重试/积压冲刷若恰好落进静默窗口（如 01:59 失败 → 02:00 重试），
    // 一律推迟到窗口结束——静默语义不因重试破例
    if (inQuietHours()) {
      const { items } = readStore();
      if (items.length > 0) {
        scheduleFlush(Math.max(nextQuietEnd().getTime() - Date.now(), 1000));
        return;
      }
    }
    let anySuccess = false;
    for (let round = 0; round < FLUSH_ROUNDS; round++) {
      const { items, failures } = readStore();
      if (items.length === 0) break;

      console.log(`[晚间静默] 开始冲刷积压 ${items.length} 条...`);
      const remaining = [];
      const exhausted = [];
      for (const item of items) {
        try {
          await runItem(item);
          anySuccess = true;
          console.log(`[晚间静默] 积压补跑完成: ${describeItem(item)}`);
        } catch (err) {
          item.attempts = (item.attempts || 0) + 1;
          if (item.attempts >= retryMaxAttempts()) {
            console.error(`[晚间静默] 积压补跑连续 ${item.attempts} 次失败，转失败补报: ${describeItem(item)} — ${err.message}`);
            exhausted.push({
              name: item.name,
              attempts: item.attempts,
              lastError: String((err && err.message) || err),
              failedAt: new Date().toISOString(),
            });
          } else {
            remaining.push(item);
            console.error(`[晚间静默] 积压补跑失败（第 ${item.attempts} 次，保留重试）: ${describeItem(item)} — ${err.message}`);
          }
        }
      }
      writeStore(remaining, [...failures, ...exhausted]);

      if (remaining.length > 0) {
        const maxAttempts = Math.max(...remaining.map((i) => i.attempts || 0));
        scheduleFlush(inQuietHours() ? Math.max(nextQuietEnd().getTime() - Date.now(), 1000) : retryDelayMs(maxAttempts));
        return;
      }
      // 全部成功；冲刷期间新落进的积压由下一轮立刻处理
    }
    // 冲刷收尾：本轮有成功（= 网络活着的证据）且有待补报失败 → 尝试向管理员补报
    if (anySuccess) await maybeReportFailures();
  } finally {
    flushing = false;
  }
}

// ---------- 失败补报（2026-10-07 v47） ----------
// 重试耗尽的定时任务转入 failures 账目；notifier（cron 注入的管理员私信）在
// 「确认网络恢复的任务首次成功」或「冲刷有成功」时机触发，补报成功才清账——
// 断网期间补报自身也会失败，账目保留等下一次，不丢。

function registerFailureNotifier(fn) {
  failureNotifiers.push(fn);
}

async function maybeReportFailures() {
  if (reporting || failureNotifiers.length === 0) return;
  const { failures } = readStore();
  if (failures.length === 0) return;
  reporting = true;
  try {
    for (const fn of failureNotifiers) {
      await fn(failures);
    }
    // 全部 notifier 成功才清账；任一抛错保留待下次
    writeStore(readStore().items, []);
    console.log(`[任务补报] 已向管理员补报 ${failures.length} 条定时任务失败记录`);
  } catch (err) {
    console.warn(`[任务补报] 管理员补报未完成（保留账目待下次）: ${(err && err.message) || err}`);
  } finally {
    reporting = false;
  }
}

/** 启动时调用：有积压则按当前时点调度补冲刷（过点立即、未过点等到 end 整点）；
 *  有待补报失败账目且不在静默窗口 → 立即尝试向管理员补报一次 */
function initQuietHoursFlush() {
  const { items, failures } = readStore();
  if (!settings.enabled) {
    console.log('[晚间静默] 已通过 QUIET_HOURS_DISABLED=1 关闭');
    if (failures.length > 0) maybeReportFailures().catch(() => {});
    return;
  }
  if (items.length === 0) {
    console.log(`[晚间静默] 播报静默窗口 ${quietWindowDesc()}（Asia/Shanghai），当前无积压`);
    if (failures.length > 0 && !inQuietHours()) maybeReportFailures().catch(() => {});
    return;
  }
  if (inQuietHours() || shanghaiParts().minutesOfDay < settings.end * 60) {
    const end = nextQuietEnd();
    console.log(`[晚间静默] 启动时存在 ${items.length} 条积压，调度到 ${end.toLocaleString('zh-CN')} 补跑`);
    scheduleFlush(Math.max(end.getTime() - Date.now(), 1000));
  } else {
    console.log(`[晚间静默] 启动时存在 ${items.length} 条积压且已过补发时点，5 秒后立即补跑`);
    scheduleFlush(5000);
  }
}

function getStatus() {
  const { failures } = readStore();
  return {
    enabled: settings.enabled,
    window: quietWindowDesc(),
    inQuietHours: inQuietHours(),
    backlog: loadBacklog().length,
    nextFlushAt: nextFlushAt,
    pendingFailureReports: failures.length,
    lastFailures: failures.slice(-3),
  };
}

module.exports = {
  inQuietHours,
  nextQuietEnd,
  quietWindowDesc,
  shanghaiStamp,
  gateTask,
  gatePayload,
  registerTask,
  registerPayloadHandler,
  registerFailureNotifier,
  maybeReportFailures,
  initQuietHoursFlush,
  runFlush,
  getStatus,
};
