const { requestAPI } = require('./client');

// ============================================================
// 通讯录只读封装（名册自动同步的数据源，需应用具备通讯录只读权限）
// 全租户部门（自根 fetch_child）× 各部门成员，去重后输出 [{ name, openId, departments }]
// 离职/停用成员不入册；同一人多部门时部门名合并。
// ============================================================

async function listAllUsers() {
  const deptRes = await requestAPI('GET', '/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true&page_size=50');
  if (deptRes.code !== 0) throw new Error(`拉取部门失败: ${deptRes.msg} (${deptRes.code})`);
  const deptItems = deptRes.data?.items || [];
  const deptNameById = new Map([['0', '全队'], ...deptItems.map((d) => [d.open_department_id, d.name])]);

  const byOpenId = new Map();
  for (const deptId of deptNameById.keys()) {
    let pageToken = '';
    do {
      const query = new URLSearchParams({ department_id: deptId, user_id_type: 'open_id', page_size: '50' }); // 该接口 page_size 上限 50
      if (pageToken) query.set('page_token', pageToken);
      const res = await requestAPI('GET', `/contact/v3/users/find_by_department?${query.toString()}`);
      if (res.code !== 0) throw new Error(`拉取部门「${deptNameById.get(deptId)}」成员失败: ${res.msg} (${res.code})`);
      for (const u of (res.data?.items || [])) {
        if (!u.open_id || !u.name) continue;
        if (u.status && u.status.activated === false) continue;
        if (!byOpenId.has(u.open_id)) byOpenId.set(u.open_id, { name: u.name, openId: u.open_id, departments: [] });
        const deptName = deptNameById.get(deptId);
        const item = byOpenId.get(u.open_id);
        if (deptName && deptName !== '全队' && !item.departments.includes(deptName)) item.departments.push(deptName);
      }
      pageToken = res.data?.has_more ? (res.data.page_token || '') : '';
    } while (pageToken);
  }
  return [...byOpenId.values()].map((u) => ({ ...u, departments: u.departments.join('/') }));
}

module.exports = { listAllUsers };
