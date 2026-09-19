const cron = require('node-cron');
const config = require('../config');
const quietHours = require('../utils/quietHours');
const inquiry = require('../services/inquiryService');
const compensation = require('../services/compensationService');
const assistant = require('../services/assistantService');
const express = require('../services/expressService');

// ============================================================
// 定时任务（node-cron 6 段式 + Asia/Shanghai）：
//   1. 次日提醒   DUTY_PREV_REMIND_SCHEDULE  (0 0 20 * * *,  D-1 20:00 私信明日队员)
//   2. 当日询问   DUTY_ASK_SCHEDULE          (0 30 18 * * *, D 日 18:30 私信询问，开启监听窗口)
//   3. 收口       DUTY_DEADLINE_SCHEDULE     (0 0 0 * * *,   D 日 24:00（午夜）：置未做完/算总状态/生成补偿；
//                                                 0 点已跨日，归属日期由 deadline runner 显式指定为 D 日)
//   3.5 临门提醒  DUTY_LASTCALL_SCHEDULE      (0 0 23 * * *,  D 日 23:00 私信未完结队员，收口前最后触达)
//   4. 对账       DUTY_RECONCILE_SCHEDULE    (0 30 0 * * *,  每日 00:30 重算总状态/核对补偿义务)
//   5. 看板播报   DUTY_BOARD_BROADCAST_SCHEDULE (0 0 12 * * *, 每日 12:00 webhook 推今日值日看板)
//
// 晚间静默（02:00–09:00，Asia/Shanghai，可配）：
//   - 次日提醒/当日询问/对账/看板播报为可重扫任务 → gateTask，窗口内登记积压，
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
    duty_lastcall: () => inquiry.sendLastCall(),
    duty_reconcile: () => compensation.reconcile(),
    duty_board_broadcast: () => assistant.broadcastTodayBoard(),
    duty_express_broadcast: () => express.broadcastPending(),
  };

  tasks.push(scheduleTask(config.schedule.prevRemind, 'duty_prev_remind', '次日值日提醒', quietTaskRunners.duty_prev_remind));
  tasks.push(scheduleTask(config.schedule.ask, 'duty_ask', '当日值日询问', quietTaskRunners.duty_ask));
  tasks.push(scheduleTask(config.schedule.lastCall, 'duty_lastcall', '收口前临门提醒', quietTaskRunners.duty_lastcall));
  tasks.push(scheduleTask(config.schedule.reconcile, 'duty_reconcile', '值日对账', quietTaskRunners.duty_reconcile));
  tasks.push(scheduleTask(config.schedule.boardBroadcast, 'duty_board_broadcast', '看板自动播报', quietTaskRunners.duty_board_broadcast));
  // 快递未取播报（每小时整点 EXPRESS_BROADCAST_SCHEDULE；无未取跳过不发；过静默闸门，
  // 冲刷补发时以补发时刻最新数据重查——夜间已被取完的不再播）
  tasks.push(scheduleTask(config.express.broadcastSchedule, 'duty_express_broadcast', '快递未取播报', quietTaskRunners.duty_express_broadcast));

  // 收口：写表动作不延迟（不进 gateTask），仅通知载荷过闸门。
  // 24:00（0 点）收口已跨日：closeToday 默认取「今天」会落空——按上海时间回退
  // 30 分钟计算归属日期（0:00-0:30 窗口内=前一天 D 日；若手动把收口改到白天则=当天，不影响）
  const deadlineTask = cron.schedule(config.schedule.deadline, () => {
    console.log('[定时任务] 触发值日收口');
    const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000 - 30 * 60 * 1000);
    const dutyDate = shifted.toISOString().slice(0, 10);
    runClose({ dateStr: dutyDate })
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
 * 手动触发（options.bypassQuiet）不受静默限制——操作者当下明确要求执行。
 */
async function runClose(options = {}) {
  const result = await inquiry.closeToday(options);
  if (!options.dryRun && result.notifications) {
    const deferred = options.bypassQuiet ? false : quietHours.gatePayload('duty_close_notify', result.notifications, '值日收口回执');
    if (!deferred) {
      await inquiry.sendCloseNotifications(result.notifications);
    }
  }
  return result;
}

/** cron 状态（管理接口用）。任务数：6 个常规 + 1 个收口（快递播报加入后共 7，判 ≥6 容忍未来增减） */
function getCronStatus() {
  return {
    running: tasks.length >= 6,
    taskCount: tasks.length,
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
