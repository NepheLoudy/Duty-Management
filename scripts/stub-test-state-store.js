// stateStore 原子性守卫桩测（2026-11-05 全量审查批）：
// mutate 单次调用=事件循环内原子（同步无 await）；异步回调必须显式拒绝，
// 防未来调用方在回调里塞 await 打破读改写原子性（跨 await 需走整链锁范式）。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-state-store-'));
process.env.DUTY_STATE_FILE = path.join(tmp, 'state.json');
const state = require('../src/services/stateStore');

// 1. 同步 mutate 正常读改写并落盘
state.mutate((s) => { s.boards['chat-1'] = 123; });
assert.strictEqual(state.load().boards['chat-1'], 123, '同步 mutate 应生效并持久化');

// 2. 异步回调被拒（原子性守卫）
let rejected = false;
try {
  state.mutate(async (s) => { s.boards['chat-2'] = 1; });
} catch (err) {
  rejected = /同步函数|原子性/.test(err.message);
}
assert.ok(rejected, '异步回调必须被显式拒绝');

// 3. 被拒的调用不得落盘（save 不执行——防半截状态）
assert.strictEqual(state.load().boards['chat-2'], undefined, '被拒调用的变更不得落盘');

console.log('state-store 守卫桩测: 3 通过 / 0 失败');
