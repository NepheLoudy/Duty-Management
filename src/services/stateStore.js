const fs = require('fs');
const path = require('path');
const config = require('../config');

// ============================================================
// 运行时状态（.duty-state.json，路径可配 DUTY_STATE_FILE）
// - sessions：当日询问后的监听会话（谁被询问了、对应哪条记录）
// - boards：群看板限流时间戳
// - obligations：缺勤补偿插入义务（下周已生成则就地插入，未生成则排队等生成时优先安置）
// - absenceStreaks：连续缺勤计数（连续两次触发加罚）
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
    console.warn('[状态] 读取状态文件失败（按空状态处理）:', err.message);
  }
  return emptyState();
}

function save(state) {
  const filePath = ensureWritableDir(statePath());
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[状态] 写状态文件失败（仅影响重启恢复）:', err.message);
  }
}

/** 读取-修改-写回（同步，状态量小不加锁） */
function mutate(fn) {
  const state = load();
  const result = fn(state);
  save(state);
  return result;
}

module.exports = { load, save, mutate, emptyState };
