// ============================================================
// 打卡时长周播执行链（2026-10-07 v48 从独立仓归并进 duty-bot）
//
// 触发（复用 duty-bot 触发体系，见 src/cron/index.js）：
//   - 周播 ZKLINK_BROADCAST_CRON（默认周一 09:30 上海）→ gateTask 静默闸门/积压/失败重试全继承；
//   - 整点对表 watchdog（自判漏播：进程不在线错过的 cron 由这里兜住——gateTask 积压
//     只管「静默窗口内错过」，不管「进程死了」；已过发送时刻且水位落后 → 立即补跑；
//     补跑同时天然承担失败重试，无需独立重试队列）。
//
// 通道水位（delivery）：{feishu, archived} 各自独立——重试只补未完成通道；
// 云文档留档未配置视为 skipped 不进重试（本地 archive/ 兜底）；首次成功前无水位
// 不自动补发（防部署即广播），可用 POST /api/attendance/test-broadcast 手动验证。
// 已知边界：云文档追加成功但响应丢失的极端场景，重试可能追加重复小节（概率极低）。
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('./config');
const report = require('./report');
const store = require('./store');
const zklinkClient = require('./zklinkClient');
const { sendCardToWebhook } = require('../feishu/webhook');
const feishuDoc = require('./feishuDoc');
const card = require('./card');
const importService = require('./importService');

let running = false;

function sendDowOrDefault() {
  return config.cronParts.dow == null ? 1 : config.cronParts.dow;
}

async function runWeekly({ offset = 0, dryRun = false, trigger = 'cron' } = {}) {
  // 播报通道门控：webhook 未配置直接 NO_CONFIG（policy 窗口可见缺什么）
  if (!config.webhookUrl) {
    const err = new Error('未配置播报 webhook（ZKLINK_WEBHOOK_URL，缺省回落 DUTY_BOARD_WEBHOOK_URL）');
    err.errcode = 'NO_CONFIG';
    throw err;
  }
  let members = store.loadMembers();
  const win = report.weekWindow(offset, Date.now(), sendDowOrDefault());
  let records;
  if (config.dataSource === 'import') {
    // 数据源=ZKLink 网页端导出的打卡明细（http 通道端点校准前不切，同 wecom 方案4 取舍）
    const st = store.loadState();
    const imported = (st.imported && st.imported.records) || [];
    if (!imported.length) {
      throw new Error('导入模式：尚无导入数据——ZKLink 网页端导出打卡明细后 POST /api/attendance/import 上传');
    }
    records = importService.filterByWindow(imported, win);
    if (!records.length) {
      throw new Error(`导入模式：已导入数据不覆盖本播报窗口 ${win.label}（导入于 ${(st.imported.importedAt || '').slice(0, 10)}，覆盖 ${st.imported.days || '?'}）`);
    }
    members = importService.mergeMembers(members, importService.deriveMembers(records));
  } else {
    const r = await zklinkClient.fetchTransactions(win.start, win.end);
    records = r.records;
  }
  const agg = report.aggregateDuration(records, members);
  const csv = report.renderCsv(win, agg);
  const filename = `打卡时长周报_${win.label.replace(/ ~ /g, '_')}.csv`;

  if (dryRun) {
    return { window: win, agg, csv, filename, sent: false, totals: agg.totals };
  }

  // 播报附件 CSV 始终落盘 exports（发送通道全挂也有底档；失败仅 warn 不阻塞播报）
  try {
    fs.mkdirSync(config.exportsDir, { recursive: true });
    fs.writeFileSync(path.join(config.exportsDir, filename), csv);
  } catch (e) {
    console.warn('[打卡周报] CSV 落盘 exports 失败（不影响播报）:', e.message);
  }

  // 本地留档（archive/ JSON+CSV，warn-only）：每次执行都刷新（幂等覆盖同周文件）
  feishuDoc.archiveLocal(win, agg, records, { dataSource: config.dataSource });

  // 每通道独立水位（duty「重试只补失败群」模式）：重试只补未完成通道
  const st = store.loadState();
  const done = st.delivery && st.delivery.weekKey === win.key ? st.delivery : { weekKey: win.key };
  const failed = [];

  // ---- 云文档留档通道（未配置=skipped 不重试，本地 archive/ 已兜底）----
  if (done.archived !== true) {
    if (config.feishuAppConfigured && config.archiveDocToken) {
      try {
        const r = await feishuDoc.archiveToDoc(win, agg, records, { dataSource: config.dataSource });
        done.archived = true;
        done.archivedBlocks = r.appended;
        console.log(`[打卡周报] 云文档留档完成：追加 ${r.appended} 块（obj_type=${r.objType || '?'}）`);
      } catch (e) {
        failed.push(`云文档留档: ${e.message}${e.hint ? `（${e.hint}）` : ''}`);
      }
    } else {
      done.archived = 'skipped';
      console.warn('[打卡周报] 云文档留档未配置（APP_ID/SECRET + ZKLINK_ARCHIVE_DOC_TOKEN），仅本地 archive/ 目录兜底');
    }
  }

  // ---- 周报卡：值日群 webhook ----
  if (done.feishu !== true) {
    try {
      await sendCardToWebhook(config.webhookUrl, config.webhookSecret, card.buildWeeklyCard(win, agg));
      done.feishu = true;
    } catch (e) {
      failed.push(`飞书: ${e.message}`);
    }
  }

  const pending = done.feishu !== true || done.archived === false || done.archived == null;
  if (pending) {
    store.mergeSaveState({
      delivery: done,
      lastError: { weekKey: win.key, at: new Date().toISOString(), message: failed.join('；') },
    });
    throw new Error(`部分通道未完成: ${failed.join('；')}`);
  }

  // 水位门控：只有目标周键=当前周期键（offset=0 的当周）才推进——test-broadcast 带
  // weekOffset>0 补看历史周时真发成功也不得回拨水位/投递快照，否则 watchdog 判当周
  // 漏播、整点重复轰炸
  if (win.key === report.weekWindow(0, Date.now(), sendDowOrDefault()).key) {
    store.mergeSaveState({
      lastSentWeekKey: win.key,
      lastArchivedWeekKey: win.key,
      lastSentAt: new Date().toISOString(),
      lastError: null,
      delivery: done, // 保留本周期投递快照（下周期自动被新 weekKey 覆盖）
    });
  }
  console.log(`[${trigger}] 打卡周报已播报: ${win.label}（${agg.totals.punches} 条记录 / 合计 ${report.fmtDuration(agg.totals.totalMs)}；留档 ${done.archived === true ? '云文档+本地' : '本地'}）`);
  return { window: win, agg, csv, filename, sent: true, totals: agg.totals };
}

async function guardedRun(opts) {
  if (running) return { skipped: true, reason: '上一轮还在跑' };
  running = true;
  try {
    return await runWeekly(opts);
  } catch (err) {
    console.error(`[打卡周报] 播报失败:`, err.message, err.hint || '');
    const win = report.weekWindow(opts.offset || 0, Date.now(), sendDowOrDefault());
    if (!opts.dryRun) await alertFailure(err, win, { manual: opts.trigger === 'manual' });
    throw err;
  } finally {
    running = false;
  }
}

// 失败告警：向 webhook 喊话（挂了则只落 lastError 供巡检）。
// 手动触发（manual）不受静默限制；自动链路的静默由 cron 层 gateTask 把关，
// 这里同周只喊一次（watchdog 会静默重试）。
async function alertFailure(err, win, { manual = false } = {}) {
  const st = store.loadState();
  if (st.lastError && st.lastError.weekKey === win.key && st.alertedWeekKey === win.key) return;
  store.mergeSaveState({ alertedWeekKey: win.key });
  if (!config.webhookUrl) return;
  const hint = err.hint ? `\n**处理提示：**${err.hint}` : '';
  try {
    await sendCardToWebhook(config.webhookUrl, config.webhookSecret, {
      config: { wide_screen_mode: true },
      header: { template: 'red', title: { content: '⚠ 打卡时长周报发送失败', tag: 'plain_text' } },
      elements: [{ tag: 'markdown', content: `**窗口：**${win.label}\n**原因：**${err.message}${hint}\n每小时自动重试，成功后补发本周报（首次成功前无水位不自动补发，可 POST /api/attendance/test-broadcast 手动补）` }],
    });
  } catch (e) {
    console.error('[打卡周报] 告警也发不出去:', e.message, e.hint || '');
  }
}

// 补发判定：已过发送时刻 && 水位落后 && 水位非空（首启保护）
function catchupNeeded(nowMs = Date.now()) {
  const st = store.loadState();
  if (!st.lastSentWeekKey) return null; // 首启：等下一个 cron 周期
  const { dow } = config.cronParts;
  const sendDow = dow == null ? 1 : dow;
  if (!report.isPastSendTime(nowMs, sendDow, config.cronParts.hour, config.cronParts.minute)) return null;
  const win = report.weekWindow(0, nowMs, sendDow);
  if (st.lastSentWeekKey === win.key) return null;
  return win;
}

// watchdog runner（cron/index.js 每小时 5 分调度，过 gateTask 静默闸门）
async function watchdogTick() {
  const win = catchupNeeded();
  if (!win) return;
  console.log(`[打卡周报] 发现漏播（水位落后于 ${win.key}），补发`);
  await guardedRun({ trigger: 'watchdog' });
}

module.exports = { runWeekly, guardedRun, catchupNeeded, watchdogTick };
