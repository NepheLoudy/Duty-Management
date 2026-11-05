/**
 * 离线桩测 · cron 状态口径（2026-11-05 getCronStatus 判据修正回归）：
 *   旧判据 tasks.length >= 6 纯数任务数，注释还称「默认 14」与实际（默认配置 14、
 *   zklink 启时 16）不符——zklink 周报/watchdog 是可选任务，一启就把「缺核心任务」
 *   的残废态误判成 running。新判据=核心任务名齐备（7 固定名 + 提前预告按配置域展开
 *   的真实名），可选任务（zklink 2 个）与插件自管 cron（rosterFill）不参与。验证：
 *     ①全量注册（默认配置 + zklink 开，任务总数 16）→ running=true，registeredTasks
 *       含全部核心名；
 *     ②zklink 关（核心任务一个不少，任务总数 14）→ running 仍 true（可选任务不参与判定）；
 *     ③核心任务残缺（无名化模拟注册链路断）→ running=false，即使任务总数再高
 *       （对旧阈值判据的证伪场景）；
 *     ④stopCronJobs 清空 → running=false / taskCount=0；
 *     ⑤提前预告按配置域展开：days=[7] 时 duty_ahead_remind_d7 在册、_d3 缺失不误伤。
 *   外部依赖全劫持：node-cron 换内存假调度（不真起定时器）、业务 service 模块换空桩
 *   （不触网不读表）、quietHours 最小桩（registerTask 仅入内存表）。
 * 用法：node scripts/stub-test-cron-status.js
 */
const assert = require('assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---- 环境隔离（必须在 require src/cron 前）----
process.env.QUIET_BACKLOG_FILE = path.join(require('os').tmpdir(), `quiet-backlog-cron-test-${process.pid}-${Date.now()}.json`);
process.env.QUIET_HOURS_DISABLED = '1';
delete process.env.DUTY_AHEAD_REMIND_DAYS;

// ---- 劫持：node-cron 假调度 + 业务模块空桩 ----
const Module = require('module');
const SCHEDULED = [];
const cronStub = {
  schedule(expr, fn) {
    const t = { expr, fn, stopped: false, stop() { this.stopped = true; } };
    SCHEDULED.push(t);
    return t;
  },
};
const STUBBED = new Set([
  'node-cron', '../services/inquiryService', '../services/compensationService',
  '../services/assistantService', '../services/expressService', '../services/rosterService',
  '../services/stateStore', '../feishu/bot', '../zklink/service', '../utils/quietHours',
]);
const realLoad = Module._load;
let zklinkConfigEnabled = true;
Module._load = function hooked(request, parent, isMain) {
  if (request === 'node-cron') return cronStub;
  if (STUBBED.has(request)) {
    if (request === '../zklink/service') return { guardedRun: async () => ({}), watchdogTick: async () => ({}) };
    if (request === '../utils/quietHours') {
      // quietHours 最小桩：gateTask/registerTask/registerPayloadHandler/initQuietHoursFlush 全入内存
      const registered = new Map();
      return {
        shanghaiStamp: () => '2026-11-05 12:00:00',
        registerTask: (n, fn) => registered.set(n, fn),
        registerPayloadHandler: () => {},
        registerFailureNotifier: () => {},
        initQuietHoursFlush: () => {},
        gateTask: async () => {},
        gatePayload: () => false,
        getStatus: () => ({ registeredTasks: [...registered.keys()], disabled: true }),
      };
    }
    return new Proxy({}, { get: () => async () => ({}) });
  }
  if (request === '../zklink/config' || request === './zklink/config') {
    if (parent && parent.filename && parent.filename.endsWith(path.join('src', 'cron', 'index.js'))) {
      // getter 形式：模块加载一次后 zklinkConfig 引用定型，后续场景切换靠 getter 读实时值
      return { get enabled() { return zklinkConfigEnabled; }, cron: '0 30 9 * * 1' };
    }
  }
  return realLoad.apply(this, arguments);
};

// config 用真实实现（schedule 默认值参与判定），但锁 env 干扰
process.env.DUTY_STATE_FILE = path.join(require('os').tmpdir(), `duty-cron-test-${process.pid}-${Date.now()}.json`);
process.env.EXPRESS_STATE_FILE = process.env.DUTY_STATE_FILE;

const { startCronJobs, stopCronJobs, getCronStatus } = require('../src/cron');

let pass = 0;
const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log(`  ✅ ${label}`); };

// ---- ① 全量注册（zklink 开）----
stopCronJobs();
SCHEDULED.length = 0;
zklinkConfigEnabled = true;
startCronJobs();
let st = getCronStatus();
ok(st.running === true, '全量注册（含 zklink）→ running=true');
ok(st.registeredTasks.includes('duty_ask') && st.registeredTasks.includes('duty_reconcile')
  && st.registeredTasks.includes('duty_board_broadcast') && st.registeredTasks.includes('duty_express_broadcast'),
  'registeredTasks 含核心任务真实名（duty_ask/duty_reconcile/duty_board_broadcast/duty_express_broadcast）');
ok(st.registeredTasks.includes('duty_ahead_remind_d7') && st.registeredTasks.includes('duty_ahead_remind_d3'),
  '提前预告按配置域展开（duty_ahead_remind_d7/_d3）');
ok(st.registeredTasks.includes('duty_zklink_broadcast') && st.registeredTasks.includes('duty_zklink_watchdog'),
  'zklink 可选任务在册（zklink 开时）');
ok(st.taskCount === 16, `默认配置+zklink 任务总数 16（实际 ${st.taskCount}：7 固定+提前预告 2 域×3 槽+收口 1+zklink 2）`);

// ---- ② zklink 关：核心任务一个不少，running 不受影响 ----
stopCronJobs();
SCHEDULED.length = 0;
zklinkConfigEnabled = false;
startCronJobs();
st = getCronStatus();
ok(st.running === true, 'zklink 关（核心任务仍齐备）→ running=true（可选任务不参与判定）');
ok(!st.registeredTasks.includes('duty_zklink_broadcast'), 'zklink 任务不在册（zklink 关时）');
ok(st.taskCount === 14, `默认配置（zklink 关）任务总数 14（实际 ${st.taskCount}）`);

// ---- ③ 残废态：任务被裁剪 → running=false ----
// 真实注册是全量的，用假调度侧停掉核心任务模拟注册失败/运行中被裁剪的残废态：
// node-cron task.stop() 后对象仍在 tasks 里（stopCronJobs 才摘除）——判据按 taskName
// 在册判 running，故模拟「核心任务没注册成功」需要从源头裁。走 zklink 开+删核心任务
// 的场景验证判据本身：直接对假调度记录做破坏（把 SCHEDULED 里 ask/reconcile 对象的
// taskName 删掉=「无名任务」，对应旧实现里根本没传名字的形态）
stopCronJobs();
SCHEDULED.length = 0;
zklinkConfigEnabled = true;
startCronJobs();
// 假调度侧模拟：两个核心任务变无名（scheduleTask 之外直接 cron.schedule 的旧形态，
// 如收口 deadlineTask 就是无名任务——它本来就不在判据里；这里把 ask/reconcile 一起无名化，
// 模拟「这俩任务注册链路断掉」的残废态）
for (const t of SCHEDULED) {
  if (t.taskName === 'duty_ask' || t.taskName === 'duty_reconcile') delete t.taskName;
}
st = getCronStatus();
ok(st.running === false, '核心任务无名化（duty_ask/duty_reconcile 注册链路断）→ running=false');
ok(st.taskCount >= 16, `任务总数仍高（实际 ${st.taskCount}）但 running=false——旧阈值判据会把此残废态误判成 running`);

// ---- ④ stopCronJobs 空态 ----
stopCronJobs();
st = getCronStatus();
ok(st.running === false, 'stopCronJobs 后（tasks 空）→ running=false');
ok(st.taskCount === 0, 'stopCronJobs 后 taskCount=0');

// ---- ⑤ 提前预告域展开（days=[7] 单域）----
process.env.DUTY_AHEAD_REMIND_DAYS = '7';
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/cron')];
zklinkConfigEnabled = false;
const cronReloaded = require('../src/cron');
cronReloaded.startCronJobs();
st = cronReloaded.getCronStatus();
ok(st.running === true, '单域 days=[7] 核心齐备 → running=true');
ok(st.registeredTasks.includes('duty_ahead_remind_d7') && !st.registeredTasks.includes('duty_ahead_remind_d3'),
  '单域配置：d7 在册、d3 不在（按配置展开，不虚报缺席域）');
delete process.env.DUTY_AHEAD_REMIND_DAYS;

cronReloaded.stopCronJobs();
console.log(`\n结果：${pass} 通过 / 0 失败`);
process.exit(0);
