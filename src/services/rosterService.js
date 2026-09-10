const fs = require('fs');
const config = require('../config');

// ============================================================
// 名册与白名单（本地 JSON，账号 open_id 为主键）
// - config/members.json：真实名册，永不进 git（仓库只保留 members.example.json）
//   { members: [{ name, openId, admin? }] }
//   openId 为空的成员照常排班（表格按姓名），但跳过私信提醒并标注「未绑定」，
//   其本人可私信「绑定 姓名」完成绑定（绑定即时写回名册文件）。
// - config/whitelist.json：白名单只写人名，零门槛维护
//   { names: ["某人"] }，系统按姓名映射到名册后从值日队列排除。
// ============================================================

function loadMembers() {
  try {
    if (!fs.existsSync(config.membersFile)) {
      console.warn(`[名册] 未找到名册文件 ${config.membersFile}，请照 config/members.example.json 创建`);
      return [];
    }
    const data = JSON.parse(fs.readFileSync(config.membersFile, 'utf-8'));
    const members = Array.isArray(data.members) ? data.members : [];
    return members
      .filter((m) => m && typeof m.name === 'string' && m.name.trim())
      .map((m) => ({
        name: m.name.trim(),
        openId: (m.openId || '').trim(),
        admin: Boolean(m.admin),
      }));
  } catch (err) {
    console.error('[名册] 读取名册失败（按空名册处理）:', err.message);
    return [];
  }
}

function loadWhitelistNames() {
  try {
    if (!fs.existsSync(config.whitelistFile)) {
      console.warn(`[名册] 未找到白名单文件 ${config.whitelistFile}（不排除任何人），请照 config/whitelist.example.json 创建`);
      return [];
    }
    const data = JSON.parse(fs.readFileSync(config.whitelistFile, 'utf-8'));
    return Array.isArray(data.names) ? data.names.map((n) => String(n).trim()).filter(Boolean) : [];
  } catch (err) {
    console.error('[名册] 读取白名单失败（不排除任何人）:', err.message);
    return [];
  }
}

/** 全体名册 */
function getMembers() {
  return loadMembers();
}

/** 值日队列 = 名册 − 白名单（按姓名排除） */
function getQueue() {
  const members = loadMembers();
  const whitelist = new Set(loadWhitelistNames());
  return members.filter((m) => !whitelist.has(m.name));
}

function findByName(name) {
  return loadMembers().find((m) => m.name === name) || null;
}

function findByOpenId(openId) {
  if (!openId) return null;
  return loadMembers().find((m) => m.openId && m.openId === openId) || null;
}

/** 排班生成权限人：显式配置优先（DUTY_ADMIN_OPEN_IDS），否则取名册 admin:true */
function getAdminOpenIds() {
  if (config.adminOpenIds.length > 0) return config.adminOpenIds;
  return loadMembers().filter((m) => m.admin && m.openId).map((m) => m.openId);
}

function isAdminOpenId(openId) {
  return Boolean(openId) && getAdminOpenIds().includes(openId);
}

/**
 * 绑定：把 open_id 写回名册里同名成员（值日助手「绑定 姓名」通道）。
 * @returns {{ok: boolean, message: string}}
 */
function bindOpenId(name, openId) {
  if (!name || !openId) return { ok: false, message: '绑定需要姓名与 open_id' };
  let target = null;
  let members;
  try {
    const raw = JSON.parse(fs.readFileSync(config.membersFile, 'utf-8'));
    members = Array.isArray(raw.members) ? raw.members : [];
  } catch (err) {
    return { ok: false, message: `名册文件不可读：${err.message}` };
  }
  target = members.find((m) => m && typeof m.name === 'string' && m.name.trim() === name);
  if (!target) return { ok: false, message: `名册中没有「${name}」，请联系管理员补充名册` };
  const sameIdOther = members.find((m) => m !== target && (m.openId || '') === openId);
  if (sameIdOther) {
    return { ok: false, message: `该账号已绑定给「${sameIdOther.name}」，如需改绑请联系管理员` };
  }
  target.openId = openId;
  try {
    fs.writeFileSync(config.membersFile, JSON.stringify({ members }, null, 2));
  } catch (err) {
    return { ok: false, message: `名册文件不可写：${err.message}` };
  }
  console.log(`[名册] 已绑定账号 -> ${name}`);
  return { ok: true, message: `✅ 已绑定「${name}」，之后的值日提醒会私信你` };
}

/** 启动校验：白名单查无人名 / 未绑定成员，仅告警不影响运行 */
function validateStartup() {
  const members = loadMembers();
  const byName = new Set(members.map((m) => m.name));
  for (const wl of loadWhitelistNames()) {
    if (!byName.has(wl)) {
      console.warn(`[名册] 白名单里的「${wl}」在名册中查无此人，请核对拼写`);
    }
  }
  const unbound = members.filter((m) => !m.openId).map((m) => m.name);
  if (unbound.length > 0) {
    console.log(`[名册] 未绑定账号的成员（照常排班，跳过私信）: ${unbound.join('、')}`);
  }
  if (getAdminOpenIds().length === 0) {
    console.warn('[名册] 未配置排班生成权限人（名册 admin:true 或 DUTY_ADMIN_OPEN_IDS），「生成排班表」将无人可用');
  }
  console.log(`[名册] 共 ${members.length} 人，白名单排除后值日队列 ${getQueue().length} 人`);
}

module.exports = {
  loadMembers,
  loadWhitelistNames,
  getMembers,
  getQueue,
  findByName,
  findByOpenId,
  getAdminOpenIds,
  isAdminOpenId,
  bindOpenId,
  validateStartup,
};
