const cron = require('node-cron');
const config = require('../config');
const quietHours = require('../utils/quietHours');
const inquiry = require('../services/inquiryService');
const compensation = require('../services/compensationService');

// ============================================================
// 定时任务（node-cron 6 段式 + Asia/Shanghai）：
//   1. 次日提醒   DUTY_PREV_REMIND_SCHEDULE  (0 0 20 * * *,  D-1 20:00 私信明日队员)
//   2. 当日询问   DUTY_ASK_SCHEDULE          (0 30 18 * * *, D 日 18:30 私信询问，开启监听窗口)
//   3. 收口       DUTY_DEADLINE_SCHEDULE     (0 0 22 * * *,  D 日 22:00：置未做完/算总状态/生成补偿)
//   4. 对账       DUTY_RECONCILE_SCHEDULE    (0 30 0 * * *,  每日 00:30 重算总状态/核对补偿义务)
//
// 晚间静默（02:00–09:00，Asia/Shanghai，可配）：
//   - 次日提醒/当日询问/对账为可重扫任务 → gateTask，窗口内登记积压，
//     冲刷时重跑整个任务函数（以补发时刻最新数据重查）；
//   - 收口的写表动作不延迟（静默期语义），永远立即执行；只有收口回执通知
//     属一次性事件通知 → gatePayload 落盘、窗口结束整点按序补发；
//   - 人工当下主动触发（/api/bot/test-* 手动接口，含 dryRun）不受限。
// ============================================================

let tasks = [];

function scheduleTask(expr, name, label, runner) {
  const task = cron.schedule(expr, () => {
    console.log(`[定时任务] 触发${label}`);
    quietHours
      .gateTask(name, quietHours.shanghaiStamp(), runner, label)
      .catch((err) => console.error(`[定时任务] ${label}失败:`, err.message));
  }, { timezone: 'Asia/Shanghai' });
  console.log(`[定时任务] ${label}已启动: ${expr} (Asia/Shanghai)`);
  return task;
}

/** 启动全部定时任务 */
function startCronJobs() {
  stopCronJobs();

  // 静默积压冲刷执行器：与 cron 回调共用同一执行链（重跑整个任务函数）
  const quietTaskRunners = {
    duty_prev_remind: () => inquiry.sendPrevDayRemind(),
    duty_ask: () => inquiry.askToday(),
    duty_reconcile: () => compensation.reconcile(),
  };

  tasks.push(scheduleTask(config.schedule.prevRemind, 'duty_prev_remind', '次日值日提醒', quietTaskRunners.duty_prev_remind));
  tasks.push(scheduleTask(config.schedule.ask, 'duty_ask', '当日值日询问', quietTaskRunners.duty_ask));
  tasks.push(scheduleTask(config.schedule.reconcile, 'duty_reconcile', '值日对账', quietTaskRunners.duty_reconcile));

  // 收口：写表动作不延迟（不进 gateTask），仅通知载荷过闸门
  const deadlineTask = cron.schedule(config.schedule.deadline, () => {
    console.log('[定时任务] 触发值日收口');
    runClose()
      .catch((err) => console.error('[定时任务] 值日收口失败:', err.message));
  }, { timezone: 'Asia/Shanghai' });
  tasks.push(deadlineTask);
  console.log(`[定时任务] 值日收口已启动: ${config.schedule.deadline} (Asia/Shanghai)`);

  for (const [name, fn] of Object.entries(quietTaskRunners)) {
    quietHours.registerTask(name, fn);
  }
  quietHours.registerPayloadHandler('duty_close_notify', (payload) => inquiry.sendCloseNotifications(payload));
  quietHours.initQuietHoursFlush();

  return tasks;
}

function stopCronJobs() {
  for (const t of tasks) t.stop();
  tasks = [];
}

/**
 * 收口执行链（cron 与手动接口共用）：业务写表立即执行；
 * 回执通知非静默直接发送、静默窗口内落盘积压（一次性事件通知按序补发）。
 */
async function runClose(options = {}) {
  const result = await inquiry.closeToday(options);
  if (!options.dryRun && result.notifications) {
    const deferred = quietHours.gatePayload('duty_close_notify', result.notifications, '值日收口回执');
    if (!deferred) {
      await inquiry.sendCloseNotifications(result.notifications);
    }
  }
  return result;
}

/** cron 状态（管理接口用） */
function getCronStatus() {
  return {
    running: tasks.length === 4,
    schedules: config.schedule,
    quietHours: quietHours.getStatus(),
  };
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  runClose,
  getCronStatus,
};
