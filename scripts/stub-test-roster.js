/**
 * 名册通讯录同步 + 定制窗口 stub 测试（stub：临时名册文件 + mock contacts 层，不触网）
 * 覆盖：同步写回（openId 直取通讯录/admin 按姓名保留/dept 随带）、白名单增删、
 *      GET /api/duty/roster 全景、POST /api/duty/roster/refresh、GET/POST /api/duty/whitelist。
 * 运行：npm run test:roster
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

// ---- 环境隔离（必须在 require 任何 src 模块前设置） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-bot-roster-test-'));
process.env.QUIET_HOURS_DISABLED = '1';
process.env.DUTY_STATE_FILE = path.join(TMP, 'state.json');
process.env.DUTY_MEMBERS_FILE = path.join(TMP, 'members.json');
process.env.DUTY_WHITELIST_FILE = path.join(TMP, 'whitelist.json');
fs.writeFileSync(process.env.DUTY_MEMBERS_FILE, JSON.stringify({
  members: [{ name: '队员甲', openId: 'ou_old_a', admin: true }],
}));
fs.writeFileSync(process.env.DUTY_WHITELIST_FILE, JSON.stringify({ names: ['队员丙'] }));

// ---- stub 注入：通讯录返回固定三人（含与旧名册同名的 队员甲，验证 admin 保留） ----
require.cache[require.resolve('../src/feishu/contacts')] = {
  id: 'contacts-stub', filename: 'contacts-stub', loaded: true,
  exports: { async listAllUsers() {
    return [
      { name: '队员甲', openId: 'ou_new_a', departments: '正式' },
      { name: '队员乙', openId: 'ou_new_b', departments: '机械组/电控组' },
      { name: '队员丙', openId: 'ou_new_c', departments: '顾问组' },
    ];
  } },
};

const roster = require('../src/services/rosterService');
const app = require('../src/index');

let failed = 0;
function check(desc, cond, detail = '') {
  if (cond) console.log(`✓ ${desc}`);
  else { failed += 1; console.error(`❌ ${desc}${detail ? ` —— ${detail}` : ''}`); }
}

(async () => {
  // ① 同步写回：openId 直取通讯录、admin 按姓名保留、dept 随带
  const synced = await roster.syncFromContacts();
  check('同步：通讯录三人全部入册', synced.length === 3, JSON.stringify(synced.map((m) => m.name)));
  check('同步：同名成员 openId 更新为通讯录值', synced.find((m) => m.name === '队员甲').openId === 'ou_new_a');
  check('同步：admin 标记按姓名保留', synced.find((m) => m.name === '队员甲').admin === true);
  check('同步：多部门合并进 dept 字段', synced.find((m) => m.name === '队员乙').dept === '机械组/电控组');

  // ② 白名单增删（定制窗口的写逻辑）
  const afterAdd = roster.updateWhitelist({ add: ['队员乙'] });
  check('白名单：追加后含旧值+新值', afterAdd.includes('队员丙') && afterAdd.includes('队员乙'));
  const afterRemove = roster.updateWhitelist({ remove: ['队员丙'] });
  check('白名单：移除后队列按剩余排除项恢复', !afterRemove.includes('队员丙') && afterRemove.includes('队员乙') && roster.getQueue().length === 2);
  roster.updateWhitelist({ add: ['队员丙'], remove: ['队员乙'] }); // 还原初始：仅排除丙

  // ③ HTTP 定制窗口
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const rosterView = await (await fetch(`${base}/api/duty/roster`)).json();
  check('GET /api/duty/roster：全景统计正确',
    rosterView.total === 3 && rosterView.queue === 2 && rosterView.bound === 3,
    JSON.stringify({ total: rosterView.total, queue: rosterView.queue, bound: rosterView.bound }));
  const jia = rosterView.members.find((m) => m.name === '队员甲');
  const bing = rosterView.members.find((m) => m.name === '队员丙');
  check('GET /api/duty/roster：绑定/白名单/队列标记正确',
    jia && jia.admin === true && jia.inQueue === true && bing && bing.whitelisted === true && bing.inQueue === false,
    JSON.stringify({ jia, bing }));

  const refresh = await (await fetch(`${base}/api/duty/roster/refresh`, { method: 'POST' })).json();
  check('POST /api/duty/roster/refresh：手动同步成功', refresh.success === true && refresh.total === 3, JSON.stringify(refresh));

  const wlBefore = await (await fetch(`${base}/api/duty/whitelist`)).json();
  const wlAdd = await (await fetch(`${base}/api/duty/whitelist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ add: ['队员乙'], remove: ['队员丙'] }),
  })).json();
  check('POST /api/duty/whitelist：增删即时生效',
    wlBefore.names.includes('队员丙') && wlAdd.names.includes('队员乙') && !wlAdd.names.includes('队员丙'),
    JSON.stringify({ wlBefore, wlAdd }));
  roster.updateWhitelist({ add: ['队员丙'], remove: ['队员乙'] }); // 还原

  server.closeAllConnections?.();
  server.close();
  console.log(failed === 0 ? `\n全部通过 ✅（临时目录 ${TMP}）` : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
