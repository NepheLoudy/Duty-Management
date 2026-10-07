// ============================================================
// 本地存储（打卡域单 state 文件：成员名单 + 导入缓存 + 播报/留档水位）
//
// 文件路径见 zklink/config.js（部署目标上放项目外 duty-bot-data/zklink/）。
// 名单并入 state（不设独立 members.json）——不加 duty-bot push.js 的私有配置守卫面；
// 名单由导入自动派生合并（既有名册优先），也可经 /api/attendance/members 手工增删。
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function saveState(state) {
  ensureDir(config.stateFile);
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2) + '\n');
  return state;
}

// 合并保存：以磁盘最新 state 为底叠加 patch（runWeekly 发送耗时窗口内，import 端点
// 可能已写入新的 imported 数据——整对象替换旧快照会把并发写入回滚丢失）
function mergeSaveState(patch) {
  return saveState({ ...loadState(), ...patch });
}

function loadMembers() {
  const list = loadState().members;
  return Array.isArray(list) ? list.filter((m) => m && m.userid) : [];
}

function saveMembers(list) {
  const st = loadState();
  st.members = list;
  saveState(st);
  return list;
}

// 校验并应用成员增删（返回 {list, error}）
function applyMembersChange({ action, userid, name }) {
  const list = loadMembers();
  if (!userid || typeof userid !== 'string') return { error: 'userid 必填（ZKLink 平台人员标识）' };
  if (action === 'add') {
    if (!name || typeof name !== 'string') return { error: 'name 必填（用于周报展示）' };
    if (list.some((m) => m.userid === userid)) return { error: `userid ${userid} 已在名单中` };
    list.push({ userid, name });
  } else if (action === 'remove') {
    const idx = list.findIndex((m) => m.userid === userid);
    if (idx < 0) return { error: `userid ${userid} 不在名单中` };
    list.splice(idx, 1);
  } else {
    return { error: 'action 必须是 add 或 remove' };
  }
  saveMembers(list);
  return { list };
}

module.exports = { loadState, saveState, mergeSaveState, loadMembers, saveMembers, applyMembersChange };
