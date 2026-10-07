// ============================================================
// 飞书考勤数据源（ZKLINK_DATA_SOURCE=feishu，2026-10-07 定案：
// 曼波确认打卡数据落在飞书「考勤」应用——考勤组建在飞书考勤，同步到 ZKLink
// 只是设备侧；ZKLink 网页的飞书 SSO 账号与数据无关，账密/token 自动化均走不通，
// 飞书考勤 API 才是全自动无人值守的正路，应用身份复用 duty-bot 的 APP_ID/APP_SECRET）
//
// 核心接口（规格 2026-10-07 自飞书官方文档 Apifox 镜像核对）：
//   POST /open-apis/attendance/v1/user_flows/query?employee_type=employee_id
//     body: { user_ids: [employee_id...], check_time_from: "秒", check_time_to: "秒" }
//     → data.user_flow_results[]: { user_id, check_time(秒字符串), comment("上班打卡"),
//        location_name, check_result, record_id, ssid... }
//   GET  /open-apis/attendance/v1/groups —— 考勤组列表（组名→group_id 选组过滤用）
//   通讯录 user_id：GET /contact/v3/users（user_id_type=user_id），需 employee_id 权限
//
// 权限前置（飞书后台开，报错 99991672 自带一键开通链接）：
//   attendance:rule:readonly（考勤组）/ 打卡流水相关 scope / contact:user.employee_id:readonly
// ============================================================
const config = require('./config');
const { getTenantAccessToken } = require('../feishu/client');

const OPEN_API = 'https://open.feishu.cn/open-apis';
const BATCH_USER_LIMIT = 100; // user_flows/query 单批 user_ids 上限（官方限制内取保守值）

function feishuAttError(code, msg) {
  const err = new Error(`飞书考勤接口错误 ${code}: ${msg || ''}`);
  err.errcode = code;
  if (code === 99991672) {
    err.hint = '应用缺考勤权限：打开 duty-bot .env 里记录的一键开通链接（attendance:rule:readonly 等），在飞书开放平台给本应用开通后重试';
  }
  return err;
}

// 通讯录全员（user_id 类型标识 + 姓名）——供流水 user_ids 与姓名映射
// （contacts.js listAllUsers 同款遍历，但取 user_id_type=user_id；需 contact employee_id 权限）
async function listUsersWithUserId() {
  const token = await getTenantAccessToken();
  const depts = ['0'];
  const users = [];
  const seen = new Set();
  while (depts.length) {
    const deptId = depts.shift();
    let pageToken = '';
    do {
      const qs = new URLSearchParams({ department_id: deptId, user_id_type: 'user_id', page_size: '50' });
      if (pageToken) qs.set('page_token', pageToken);
      const res = await fetch(`${OPEN_API}/contact/v3/users?${qs}`, {
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (j.code !== 0) throw feishuAttError(j.code, j.msg);
      const list = (j.data && j.data.items) || [];
      for (const u of list) {
        if (u.department_ids) for (const d of u.department_ids) if (!depts.includes(d) && !seen.has('dept:' + d)) { depts.push(d); seen.add('dept:' + d); }
        if (u.user_id && u.name && !seen.has(u.user_id)) { seen.add(u.user_id); users.push({ userid: u.user_id, name: u.name }); }
      }
      pageToken = (j.data && j.data.page_token) || '';
    } while (pageToken);
  }
  return users;
}

// 考勤组列表（组名 → group_id；ZKLINK_ATT_GROUP_ID 可按 group_id 过滤，也可以只配组名对照）
async function listGroups() {
  const token = await getTenantAccessToken();
  const groups = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({ page_size: '50' });
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`${OPEN_API}/attendance/v1/groups?${qs}`, {
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await res.json();
    if (j.code !== 0) throw feishuAttError(j.code, j.msg);
    for (const g of (j.data && j.data.items) || []) {
      groups.push({ groupId: g.group_id, groupName: g.group_name, memberCount: g.member_count });
    }
    pageToken = (j.data && j.data.page_token) || '';
  } while (pageToken);
  return groups;
}

// user_ids 解析：env 显式配置 > 通讯录全员（user_id 标识）
async function resolveUserIds() {
  const explicit = (config.attUserIds || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return { userIds: explicit, names: new Map() };
  const users = await listUsersWithUserId();
  if (!users.length) {
    const err = new Error('无法确定打卡人员：ZKLINK_ATT_USER_IDS 未配置且通讯录未取到 user_id（检查应用 contact:user.employee_id:readonly 权限）');
    err.errcode = 'NO_CONFIG';
    throw err;
  }
  return { userIds: users.map((u) => u.userid), names: new Map(users.map((u) => [u.userid, u.name])) };
}

// 拉取窗口 [startMs, endMs) 的打卡流水（分批）→ 统一记录流
async function fetchFlows(startMs, endMs) {
  const { userIds, names } = await resolveUserIds();
  const token = await getTenantAccessToken();
  const records = [];
  for (let i = 0; i < userIds.length; i += BATCH_USER_LIMIT) {
    const batch = userIds.slice(i, i + BATCH_USER_LIMIT);
    const qs = new URLSearchParams({ employee_type: 'employee_id' });
    const res = await fetch(`${OPEN_API}/attendance/v1/user_flows/query?${qs}`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        user_ids: batch,
        check_time_from: String(Math.floor(startMs / 1000)),
        check_time_to: String(Math.floor(endMs / 1000)),
      }),
    });
    const j = await res.json();
    if (j.code !== 0) throw feishuAttError(j.code, j.msg);
    for (const f of ((j.data && j.data.user_flow_results) || [])) {
      const t = Number(f.check_time);
      if (!f.user_id || !t) continue; // 无时间/无人的脏记录跳过
      records.push({
        userid: String(f.user_id),
        _name: names.get(String(f.user_id)) || String(f.user_id),
        checkin_time: t, // 秒（与统一记录流口径一致）
        checkin_type: String(f.comment || ''),
        exception_type: f.check_result === 'Invalid' ? '无效打卡' : '',
        location_title: String(f.location_name || ''),
        wifiname: String(f.ssid || ''),
        groupname: '飞书考勤',
      });
    }
  }
  return { records, userCount: userIds.length };
}

module.exports = { fetchFlows, listGroups, listUsersWithUserId, resolveUserIds };
