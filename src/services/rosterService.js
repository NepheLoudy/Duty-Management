const fs = require('fs');
const config = require('../config');
const contacts = require('../feishu/contacts');

// ============================================================
// 名册与白名单（本地 JSON，账号 open_id 为主键）
// - config/members.json：名册，启动/生成排班时自动从飞书通讯录同步（contacts.js），
//   open_id 直接来自组织架构，「绑定 姓名」降级为人工纠错兜底；admin 标记按姓名保留。
//   { members: [{ name, openId, dept?, admin? }] }
//   openId 为空的成员照常排班（表格按姓名），但跳过私信提醒并标注「未绑定」。
// - config/whitelist.json：白名单只写人名，零门槛维护
//   { names: ["某人"] }，系统按姓名映射到名册后从值日队列排除。
// ============================================================

function loadMembers() {
  try {
    if (!fs.existsSync(config.membersFile)) {
      console.warn(`[名册] 未找到名册文件 ${config.membersFile}（启动通讯录同步会自动生成）`);
      return [];
    }
    const data = JSON.parse(fs.readFileSync(config.membersFile, 'utf-8'));
    const members = Array.isArray(data.members) ? data.members : [];
    return members
      .filter((m) => m && typeof m.name === 'string' && m.name.trim())
      .map((m) => ({
        name: m.name.trim(),
        openId: (m.openId || '').trim(),
        dept: (m.dept || '').trim(),
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

/** 原子写 JSON（2026-09-27，同 stateStore.save 范式）：写临时文件后改名，
 *  进程写一半被杀不再产生半截名册/白名单（load 侧会把半截 JSON 当损坏按空处理，
 *  名册清零 = 值日队列清零，属运行时数据事故） */
function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
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
 * 通讯录同步：全租户部门成员 → members.json（open_id 直取组织架构，无需逐人绑定）。
 * 已有名册里的 admin 标记按姓名保留；同步全程约 17 次飞书调用，瞬时网络抖动自动重试一次；
 * 通讯录为空/重试仍失败抛错由调用方兜底（不写坏本地名册）。
 * @returns {Array<{name, openId, dept, admin}>}
 */
async function syncFromContacts() {
  let users;
  try {
    users = await contacts.listAllUsers();
  } catch (err) {
    console.warn('[名册] 通讯录同步失败，1.5s 后重试一次:', err.message);
    await new Promise((r) => setTimeout(r, 1500));
    users = await contacts.listAllUsers();
  }
  if (users.length === 0) throw new Error('通讯录返回为空，跳过写回（保留本地名册）');
  let existing = [];
  try {
    const raw = JSON.parse(fs.readFileSync(config.membersFile, 'utf-8'));
    existing = Array.isArray(raw.members) ? raw.members : [];
  } catch { /* 无名册/不可读：全新生成 */ }
  const adminByName = new Set(existing.filter((m) => m && m.admin).map((m) => m.name));
  const members = users.map((u) => ({
    name: u.name,
    openId: u.openId,
    dept: u.departments || '',
    admin: adminByName.has(u.name),
  }));
  atomicWriteJson(config.membersFile, { members });
  console.log(`[名册] 通讯录同步完成：共 ${members.length} 人（admin 标记保留 ${members.filter((m) => m.admin).length} 个）`);
  return members;
}

/** 白名单增删（定制窗口用）：add/remove 人名数组，返回更新后的完整名单 */
function updateWhitelist({ add = [], remove = [] } = {}) {
  const names = new Set(loadWhitelistNames());
  for (const n of add) if (String(n).trim()) names.add(String(n).trim());
  for (const n of remove) names.delete(String(n).trim());
  const list = [...names];
  atomicWriteJson(config.whitelistFile, { names: list });
  console.log(`[名册] 白名单已更新：${list.length} 人`);
  return list;
}

/**
 * 绑定：把 open_id 写回名册里同名成员（值日助手「绑定 姓名」通道）。
 * 通讯录同步后 open_id 随名册自带，此通道仅作人工纠错兜底。
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
  // 抢占防护（2026-09-27）：目标姓名已绑定其他账号时拒绝改绑——否则任何队员私信
  // 「绑定 已绑定者姓名」即可把别人的 open_id 抢过来，代他人收值日提醒/打卡确认
  if (target.openId && target.openId !== openId) {
    return { ok: false, message: `「${name}」该姓名已绑定其他账号，如需改绑请联系管理员` };
  }
  const sameIdOther = members.find((m) => m !== target && (m.openId || '') === openId);
  if (sameIdOther) {
    return { ok: false, message: `该账号已绑定给「${sameIdOther.name}」，如需改绑请联系管理员` };
  }
  target.openId = openId;
  try {
    atomicWriteJson(config.membersFile, { members });
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
  syncFromContacts,
  updateWhitelist,
  validateStartup,
};
