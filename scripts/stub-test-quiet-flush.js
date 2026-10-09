/**
 * 离线桩测试 · 晚间静默冲刷（2026-10-10 自 ticket-bot 同批移植竞态修复回归）：
 *   runFlush 收尾若直接 writeStore(remaining, ...) 会以「本轮快照-已结算」覆盖整个
 *   积压文件，把冲刷期间新落盘的积压（gatePayload 收口回执 / gateTask 并发登记 /
 *   registerRetry 失败重试）静默丢掉。验证：
 *     ①冲刷期间新落盘的积压不被覆盖丢失，且在本轮循环内继续补跑；
 *     ②失败保留项照常回写（attempts 自增落盘），退避调度不丢条目；
 *     ③同毫秒入队的积压不互吞（身份键=入队时签发的 id）；
 *     ④failures 失败账目侧在合并保存下不丢。
 * 全部外部依赖走桩（registerTask 注册内存执行器），积压文件指向临时目录；
 * 用法：node scripts/stub-test-quiet-flush.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BACKLOG_FILE = path.join(os.tmpdir(), `quiet-backlog-duty-test-${Date.now()}.json`);
process.env.QUIET_BACKLOG_FILE = BACKLOG_FILE; // 必须在 require quietHours 前设置
process.env.QUIET_RETRY_BASE_MS = '50'; // 失败退避调小（桩测试不等真实分钟级）

const quietHours = require(path.join(ROOT, 'src/utils/quietHours.js'));

// ---- 桩：task 冲刷执行器（内存版，不触网）----
const ran = [];
let onRunTask = null; // 钩子：任务补跑时注入「冲刷期间新落盘」的模拟
const FAIL_TASKS = new Set(['t-fail', 't-fail-f', 't-fail-h']);
quietHours.registerTask('t-ok', async () => {
  ran.push('t-ok');
  if (onRunTask) { const fn = onRunTask; onRunTask = null; fn(); }
});
for (const name of FAIL_TASKS) {
  quietHours.registerTask(name, async () => { ran.push(name); throw new Error('模拟补跑失败'); });
}
quietHours.registerTask('t-other', async () => { ran.push('t-other'); });

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

function writeStore(items, failures = []) {
  fs.writeFileSync(BACKLOG_FILE, JSON.stringify({ items, failures }, null, 2));
}
function readStore() {
  try {
    if (!fs.existsSync(BACKLOG_FILE)) return { items: [], failures: [] };
    const data = JSON.parse(fs.readFileSync(BACKLOG_FILE, 'utf-8'));
    return {
      items: Array.isArray(data.items) ? data.items : [],
      failures: Array.isArray(data.failures) ? data.failures : [],
    };
  } catch { return { items: [], failures: [] }; }
}
const taskItem = (name, fireKey) => ({
  type: 'task', name, fireKey, queuedAt: new Date().toISOString(),
});

(async () => {
  console.log('\n== 1. 冲刷期间新落盘的积压不被收尾保存覆盖 ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  ran.length = 0;
  writeStore([taskItem('t-ok', 'slot-a')]);
  // 模拟：任务 A 补跑时，另一个 gateTask 并发落盘了任务 B（直写文件 = gate 的 load+push+save）
  onRunTask = () => writeStore([...readStore().items, taskItem('t-other', 'slot-b')]);
  await quietHours.runFlush();
  check('A、B 两个任务都被补跑（旧实现 B 会被覆盖丢失，只跑 1 个）', ran.includes('t-ok') && ran.includes('t-other'), JSON.stringify(ran));
  check('冲刷结束后积压文件清空（无条目残留或丢失）', readStore().items.length === 0, JSON.stringify(readStore().items.map((it) => it.fireKey)));

  console.log('\n== 2. 失败保留项照常回写（attempts 自增），不被新落盘条目挤掉 ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  ran.length = 0;
  writeStore([taskItem('t-fail', 'slot-c'), taskItem('t-ok', 'slot-d')]);
  onRunTask = () => writeStore([...readStore().items, taskItem('t-other', 'slot-e')]);
  await quietHours.runFlush();
  const after2 = readStore();
  check('成功的 D 已结算移除', !after2.items.some((it) => it.fireKey === 'slot-d'), JSON.stringify(after2.items.map((it) => it.fireKey)));
  check('失败的 C 保留且 attempts=1', after2.items.some((it) => it.fireKey === 'slot-c' && it.attempts === 1), JSON.stringify(after2.items.map((it) => ({ fireKey: it.fireKey, attempts: it.attempts }))));
  check('冲刷期间落盘的 E 同样保留（未被覆盖）', after2.items.some((it) => it.fireKey === 'slot-e'), JSON.stringify(after2.items.map((it) => it.fireKey)));

  console.log('\n== 3. 同毫秒入队的两条积压不互吞（身份键=入队时签发的 id） ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  ran.length = 0;
  const sameTs = new Date().toISOString(); // 同一毫秒戳：旧 queuedAt 身份键在此碰撞
  const badF = taskItem('t-fail-f', 'slot-f'); badF.queuedAt = sameTs; badF.id = 'id-f';
  const goodG = taskItem('t-ok', 'slot-g'); goodG.queuedAt = sameTs; goodG.id = 'id-g';
  writeStore([badF, goodG]);
  await quietHours.runFlush();
  const after3 = readStore();
  check('成功的 G 已结算移除', !after3.items.some((it) => it.fireKey === 'slot-g'), JSON.stringify(after3.items.map((it) => it.fireKey)));
  check('失败的 F 保留且 attempts=1（不被同毫秒成功条目吞掉）', after3.items.some((it) => it.fireKey === 'slot-f' && it.attempts === 1), JSON.stringify(after3.items.map((it) => ({ fireKey: it.fireKey, attempts: it.attempts }))));

  console.log('\n== 4. failures 失败账目在合并保存下不丢 ==');
  fs.rmSync(BACKLOG_FILE, { force: true });
  ran.length = 0;
  const preFailure = { name: 't-legacy', attempts: 9, lastError: '历史失败', failedAt: new Date().toISOString() };
  writeStore([taskItem('t-ok', 'slot-j')], [preFailure]);
  await quietHours.runFlush();
  const after4 = readStore();
  check('积压侧清空', after4.items.length === 0, JSON.stringify(after4.items.map((it) => it.fireKey)));
  check('failures 账目保留（合并保存不覆盖账目侧）', after4.failures.length === 1 && after4.failures[0].name === 't-legacy', JSON.stringify(after4.failures));

  fs.rmSync(BACKLOG_FILE, { force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('桩测试异常:', e); process.exit(1); });
