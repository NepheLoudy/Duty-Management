const fs = require('fs');
const path = require('path');
const config = require('../config');

// ============================================================
// 运行时状态（.duty-state.json，路径可配 DUTY_STATE_FILE）
// - sessions：当日询问后的监听会话（谁被询问了、对应哪条记录）
// - boards：群看板限流时间戳
// - obligations：缺勤补偿插入义务（下周已生成则就地插入，未生成则排队等生成时优先安置）
// - absenceStreaks：连续缺勤计数（连续两次「未做完」触发加罚；请假计入，v47 口径）
// - pendingLeaves：请假二次确认会话（防误触——请假直接生效会少一个班且牵动补偿安置）
// 生产环境必须把状态文件配到项目目录之外（SFTP 部署会清空 /opt/duty-bot）；
// 配置目录不存在时自动回退项目根并告警，保证本地开发开箱能跑。
// ============================================================

function statePath() {
  return config.stateFile;
}

function emptyState() {
  return {
    sessions: {},       // openId -> { date, recordId, name, position, askedAt }
    boards: {},         // chatId -> lastBoardAt(ms)
    obligations: [],    // { id, name, weekStart, reason, placed, placedAt, recordId, createdAt }
    absenceStreaks: {}, // name -> { count, lastDate }
    pendingLeaves: {},  // openId -> { recordId, dateStr, position, name, askedAt }（请假二次确认，2026-09-24）
    aheadReminded: {},  // "发送日|daysAhead" -> { openId: true }（提前预告当日去重，v48f；
                        // 只记发送成功者，失败者留给后续槽位补发；写入时清非今日键防膨胀）
  };
}

function ensureWritableDir(filePath) {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return filePath;
  } catch (err) {
    const fallback = path.join(__dirname, '..', '..', '.duty-state.json');
    console.warn(`[状态] 状态文件目录不可写（${dir}），回退到项目根: ${err.message}`);
    return fallback;
  }
}

function load() {
  const filePath = ensureWritableDir(statePath());
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return { ...emptyState(), ...data };
    }
  } catch (err) {
    // 损坏文件保留现场（2026-09-13）：另存 .corrupt.bak 后再按空状态启动——
    // 否则下次 mutate 会把空状态写回，排队中的补偿义务静默清零且不可恢复
    try { fs.renameSync(filePath, filePath + '.corrupt.bak'); } catch { /* 忽略 */ }
    console.error('[状态] 状态文件损坏，已另存 .corrupt.bak 并按空状态启动:', err.message);
  }
  return emptyState();
}

function save(state) {
  const filePath = ensureWritableDir(statePath());
  try {
    // 原子写（2026-09-13）：写临时文件后改名，写一半被杀不再产生半截 JSON
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('[状态] 写状态文件失败（仅影响重启恢复）:', err.message);
  }
}

/** 读取-修改-写回（同步，单次调用在事件循环内原子——无 await 即无交错）。
 *  2026-11-05 全量审查注：fn 一旦引入 await 就会打破原子性（读改写间隙被其它任务
 *  插入），故此处显式拒绝异步回调；跨 await 的 check-then-act 必须走
 *  withScheduleLock/withLeaveLock 同款整链锁范式，不许在 mutate 回调里等 IO。 */
function mutate(fn) {
  const state = load();
  const result = fn(state);
  if (result && typeof result.then === 'function') {
    throw new Error('state.mutate 回调必须是同步函数（异步回调会打破读改写原子性，跨 await 场景请用整链锁）');
  }
  save(state);
  return result;
}

module.exports = { load, save, mutate, emptyState };
