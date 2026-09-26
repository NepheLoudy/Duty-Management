// 桩测试：快递助手——窗口开闭 / 文字图片登记 / 配对补图 / 去重 / 编号刷新 / 取件确认 / 播报
// 全离线：stub 掉飞书 client（requestAPI/downloadImage/uploadMediaToBitable）与 bot 发送，
// 快递表记录存内存假仓；状态写临时文件，跑完即删
// （接入 push.js 部署前测试闸门，行为改动必须过本套件）
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');
config.express.enabled = true;
config.express.tableId = 'tblTEST';
config.express.groupChatIds = ['oc_express'];
config.stateFile = path.join(os.tmpdir(), `duty-express-test-${process.pid}-${Date.now()}.json`);

const client = require('../src/feishu/client');
const bot = require('../src/feishu/bot');
const roster = require('../src/services/rosterService');
const state = require('../src/services/stateStore');
const express = require('../src/services/expressService');

// ---- 测试桩 ----
let recordSeq = 0;
const rawRecords = []; // {record_id, fields}
const sentToChat = [];

client.requestAPI = async (method, urlPath, body) => {
  if (method === 'GET' && urlPath.includes('/records?')) {
    return {
      code: 0,
      data: {
        items: rawRecords.map((r) => ({ record_id: r.record_id, fields: r.fields })),
        has_more: false,
      },
    };
  }
  if (method === 'POST' && urlPath.endsWith('/records')) {
    const record_id = `rec${++recordSeq}`;
    rawRecords.push({ record_id, fields: { ...body.fields } });
    return { code: 0, data: { record: { record_id } } };
  }
  if (method === 'PUT' && urlPath.includes('/records/')) {
    const record_id = urlPath.split('/records/')[1];
    const rec = rawRecords.find((r) => r.record_id === record_id);
    assert.ok(rec, `更新不存在的记录 ${record_id}`);
    rec.fields = { ...rec.fields, ...body.fields };
    return { code: 0, data: {} };
  }
  throw new Error(`桩未覆盖的请求: ${method} ${urlPath}`);
};
client.downloadImage = async () => Buffer.from('fake-img');
client.uploadMediaToBitable = async () => `tok_${++recordSeq}`;
bot.sendTextToChat = async (chatId, text) => {
  sentToChat.push({ chatId, text });
  return {};
};
roster.findByOpenId = (id) => (id === 'ou_u1' ? { name: '张三' } : null);

function pickedRecords() {
  return rawRecords.filter((r) => r.fields['是否取件'] === '已取');
}
function pendingRecords() {
  return rawRecords.filter((r) => r.fields['是否取件'] !== '已取');
}

(async () => {
  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log(`  ✅ ${label}`); };

  // 1. 开窗口：引导发群，窗口生效
  let r = await express.openWindow({ chatId: 'oc_express', openId: 'ou_u1' });
  ok(r.handled && r.reply === '', '开窗口：本端自播报（reply 空）');
  ok(sentToChat.length === 1 && sentToChat[0].chatId === 'oc_express' && sentToChat[0].text.includes('登记窗口已开启'), '开窗口：群引导已发');
  ok(Boolean(state.load().express.window), '开窗口：窗口状态已落盘');

  // 2. 重复开窗 → 提示进行中
  r = await express.openWindow({ chatId: 'oc_express', openId: 'ou_u1' });
  ok(r.reply.includes('已有登记窗口进行中'), '重复开窗：提示剩余时间');

  // 3. 窗口内文字登记
  r = await express.observe({ text: '12-3-4567', openId: 'ou_u1', messageId: 'm1', chatId: 'oc_express' });
  ok(r.reply === '' && pendingRecords().length === 1, '窗口文字：登记为未取');
  const rec1 = pendingRecords()[0];
  ok(rec1.fields['取件码'] === '12-3-4567' && rec1.fields['发起人']?.[0]?.id === 'ou_u1', '窗口文字：取件码与发起人正确');

  // 4. 同 messageId 重投去重
  await express.observe({ text: '12-3-4567', openId: 'ou_u1', messageId: 'm1', chatId: 'oc_express' });
  ok(pendingRecords().length === 1, '同 messageId 重投：不重复登记');

  // 5. 图片配对：同人文字记录补图（不新建）
  await express.observe({ imageKey: 'k1', openId: 'ou_u1', messageId: 'm2', chatId: 'oc_express' });
  ok(rec1.fields['快递内容']?.length === 1 && pendingRecords().length === 1, '图片配对：补进本人无图记录');

  // 6. 陌生人纯图片 → 新建纯图记录
  await express.observe({ imageKey: 'k2', openId: 'ou_x9', messageId: 'm3', chatId: 'oc_express' });
  ok(pendingRecords().length === 2, '纯图片：无配对对象时新建');
  ok(rawRecords[1].fields['消息ID'] === 'm3', '纯图片：消息ID 落表（幂等依据）');

  // 7. 指令/取件词不当取件码
  await express.observe({ text: '已取1', openId: 'ou_u1', messageId: 'm4', chatId: 'oc_express' });
  await express.observe({ text: '/快递', openId: 'ou_u1', messageId: 'm5', chatId: 'oc_express' });
  ok(pendingRecords().length === 2, '取件词与斜杠指令：不被登记为取件码');

  // 8. 无窗口静默
  state.mutate((st) => { delete st.express.window; });
  await express.observe({ text: '99-9-0001', openId: 'ou_u1', messageId: 'm6', chatId: 'oc_express' });
  ok(pendingRecords().length === 2, '无窗口：观察消息静默忽略');
  await express.openWindow({ chatId: 'oc_express', openId: 'ou_u1' }); // 重新开窗供后续用例
  sentToChat.length = 0;

  // 9. 窗口未到期不关
  ok((await express.closeWindowIfDue()) === null, '窗口未到期：不关闭');

  // 10. 到期关闭：摘要编号 + 摘要发群
  state.mutate((st) => { st.express.window.expiresAt = Date.now() - 1000; });
  const closed = await express.closeWindowIfDue();
  ok(closed && closed.chatId === 'oc_express', '到期关闭：窗口清除');
  const summary = sentToChat.find((s) => s.text.includes('登记窗口关闭'));
  ok(Boolean(summary) && summary.text.includes('2 件'), '关窗摘要：统计窗口内登记 2 件');
  ok(Boolean(state.load().express.numbers), '关窗摘要：编号已分配');

  // 11. 查询：编号按登记顺序 1..N，含未留码标注
  r = await express.queryPending();
  ok(r.reply.includes('1. 12-3-4567') && r.reply.includes('2. （未留码）'), '查询：编号与未留码标注');

  // 12. 取件（带编号）：备注列记录确认人（2026-09-27）
  r = await express.handlePickup({ arg: '1', openId: 'ou_u1' });
  ok(r.reply.includes('编号 1（12-3-4567）已记为已取'), '已取1：确认回执');
  ok(pickedRecords().length === 1 && pendingRecords().length === 1, '已取1：表格是否取件=已取');
  ok(Boolean(pickedRecords()[0].fields['取件时间']), '已取1：取件时间落表');
  ok(pickedRecords()[0].fields['备注'] === '确认人：张三', '已取1：备注记录确认人');

  // 13. 旧编号再次取 → 无此编号（两次播报间编号稳定，不自动重排）
  r = await express.handlePickup({ arg: '1' });
  ok(r.reply.includes('没有编号 1'), '已失效编号：提示编号已刷新');

  // 14. 查询刷新编号 → 剩余件变 1
  r = await express.queryPending();
  ok(r.reply.includes('1. （未留码）'), '查询即刷新：剩余件重排为 1');

  // 15. 多件时不带编号 → 引导
  await express.openWindow({ chatId: 'oc_express', openId: 'ou_u1' }); // 登记需要窗口
  await express.observe({ text: '55-5-1111', openId: 'ou_u1', messageId: 'm7', chatId: 'oc_express' });
  r = await express.handlePickup({ arg: '' });
  ok(r.reply.includes('请带编号回复') && r.reply.includes('全部已取'), '多件无编号：引导带编号');
  // 但先清掉刚登记的再继续（保持后续用例状态可控）——「全部已取」两步确认（2026-09-27：
  // 首次只武装确认不清表，60 秒内同 openId 复核词才生效；未武装的复核词不生效）
  r = await express.handlePickup({ arg: 'all' });
  ok(r.reply.includes('确认全部已取') && r.reply.includes('2 件') && pendingRecords().length === 2, '全部已取第一步：仅武装确认，表格未动');
  const rOther = await express.handlePickup({ arg: 'all', confirm: true, openId: 'ou_other' });
  ok(rOther.reply.includes('没有待确认') && pendingRecords().length === 2, '他人未武装直接确认：不生效不清表');
  r = await express.handlePickup({ arg: 'all', confirm: true });
  ok(pendingRecords().length === 0 && rawRecords.length === 3, '全部已取第二步：确认后三件全记已取');

  // 16. 全空播报跳过
  r = await express.broadcastPending();
  ok(r.skipped && r.reason === 'empty', '播报：无未取跳过');

  // 17. 有未取时播报文案
  await express.observe({ text: '77-7-2222', openId: 'ou_x9', messageId: 'm8', chatId: 'oc_express' });
  r = await express.broadcastPending({ dryRun: true });
  ok(!r.skipped && r.text.includes('77-7-2222') && r.text.includes('已取编号'), '播报：清单含取件码与取件指引');

  // 18. 指令路由：帮助 / 开窗别名
  r = await express.handleCommand('快递助手', {});
  ok(r.reply.includes('快递助手用法'), '指令：快递助手 = 帮助');
  r = await express.handleCommand('查询当前快递', {});
  ok(r.handled && r.reply.includes('未取 1 件'), '指令：查询当前快递');

  // 19. 单件时「已取」不带编号直接生效
  r = await express.handlePickup({ arg: '' });
  ok(r.reply.includes('唯一一件'), '单件：已取不带编号生效');

  // 20. 无窗口：群图片直调路径（assistantService group 分支直达，不过 observe）静默——不落脏记录
  state.mutate((st) => { delete st.express.window; });
  const beforeImgs = rawRecords.length;
  await express.handleImagePayload({ imageKey: 'k0', openId: 'ou_u1', messageId: 'm_img0', chatId: 'oc_express' });
  ok(rawRecords.length === beforeImgs, '无窗口：群图片直调路径静默忽略');

  // 21. 窗口内直调：非窗口群 chatId 静默
  await express.openWindow({ chatId: 'oc_express', openId: 'ou_u1' });
  sentToChat.length = 0;
  await express.handleImagePayload({ imageKey: 'k8', openId: 'ou_x9', messageId: 'm_img2', chatId: 'oc_other' });
  ok(rawRecords.length === beforeImgs, '窗口内直调：非窗口群图片静默忽略');

  // 22. 窗口内直调：本群图片正常登记（旧记录均已取，无可配对对象 → 新建纯图记录）
  await express.handleImagePayload({ imageKey: 'k9', openId: 'ou_x9', messageId: 'm_img1', chatId: 'oc_express' });
  ok(pendingRecords().length === 1 && rawRecords[rawRecords.length - 1].fields['消息ID'] === 'm_img1', '窗口内直调：本群图片正常登记');

  console.log(`\n结果：${pass} 通过 / 0 失败`);
  try { fs.unlinkSync(config.stateFile); } catch { /* 忽略 */ }
  process.exit(0);
})().catch((err) => {
  console.error('❌ 测试失败:', err);
  try { fs.unlinkSync(config.stateFile); } catch { /* 忽略 */ }
  process.exit(1);
});
