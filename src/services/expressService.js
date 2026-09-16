const config = require('../config');
const bot = require('../feishu/bot');
const roster = require('./rosterService');
const state = require('./stateStore');
const policy = require('./policyService');
// 以模块对象调用（不解构），桩测试可整体替换 client.requestAPI/downloadImage/uploadMediaToBitable
const client = require('../feishu/client');

// ============================================================
// 快递助手（快递申领群专属，经 hub 转发的被动指令层，2026-09-17 新增）
// - 「快递」开启 5 分钟登记窗口：窗口内群里发的取件码文字 / 快递照片
//   直接登记进「机器人项目看板」base 的「快递」表（是否取件=未取，机器人填写；
//   表结构用户手工建：发起人(用户主键)/快递内容(附件)/取件码/是否取件(+脚本补
//   登记时间/取件时间/消息ID 三列)）；不经窗口的群消息一律忽略，
//   duty-bot 仍不消费消息事件（hub 观察转发）
// - 每小时整点播报未取清单（取件码 + 编号），取完发「已取n」或「全部已取」；
//   编号在每次播报/查询时按登记顺序刷新，两次播报之间保持稳定（按最后一次
//   播报的编号对账，多件时必须带编号）
// ============================================================

const HELP_TEXT = [
  '📦 快递助手用法：',
  '· 「快递」—— 开启 5 分钟快递登记窗口（窗口内把取件码发到群里即可，可跟发快递照片）',
  '· 「查询当前快递」—— 查看当前未取清单与编号',
  '· 取完后发「@机器人 已取编号」（如「已取1」，多件时必须带编号）或「全部已取」',
  '· 每小时整点自动播报一次未取清单（无未取则不播）',
  '',
  '「是否取件」由机器人自动填写，无需手工维护。',
].join('\n');

// 取件回复词（hub 侧经策略 groupForwardPatterns 放行 @ 转发；本仓防御直调同款）
const PICKUP_ONE_RE = /^已取\s*(\d+)?$/;

/** 表字段名（与「快递」表现状一致；手动改名时改 .env） */
function f() {
  return config.express.fields;
}

function requireExpressTable() {
  if (!config.express.enabled) throw new Error('快递助手未启用（EXPRESS_ENABLED=0）');
  if (!config.express.appToken || !config.express.tableId) {
    throw new Error('快递表未配置（EXPRESS_BITABLE_APP_TOKEN / EXPRESS_TABLE_ID）');
  }
  return config.express;
}

function fieldText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((seg) => (typeof seg === 'string' ? seg : seg.text || '')).join('');
  }
  return String(value);
}

/** 人员字段（User 数组）→ 第一个 open_id */
function fieldFirstUserId(value) {
  if (!Array.isArray(value)) return '';
  return (value[0] && value[0].id) || '';
}

function fieldAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((a) => a && a.file_token);
}

function normalizeRecord(raw) {
  const fields = raw.fields || {};
  const senderOpenId = fieldFirstUserId(fields[f().senderUser]);
  const member = senderOpenId ? roster.findByOpenId(senderOpenId) : null;
  return {
    recordId: raw.record_id,
    code: fieldText(fields[f().code]),
    senderOpenId,
    sender: (member && member.name) || (senderOpenId ? `成员${String(senderOpenId).slice(-4)}` : '（未知）'),
    messageId: fieldText(fields[f().messageId]),
    regMs: Number(fields[f().regTime] || 0),
    picked: fieldText(fields[f().picked]) === '已取',
    pickedAtMs: Number(fields[f().pickedAt] || 0),
    imageTokens: fieldAttachments(fields[f().image]).map((a) => a.file_token),
  };
}

/** 快递表全量记录（登记时间升序；表小，直接全拉客户端过滤） */
async function listExpressRecords() {
  const cfg = requireExpressTable();
  const out = [];
  let pageToken = '';
  do {
    const res = await client.requestAPI(
      'GET',
      `/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`,
      null,
    );
    if (res.code !== 0) throw new Error(`快递表读取失败: ${res.msg} (${res.code})`);
    const data = res.data || {};
    out.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken);
  return out
    .map(normalizeRecord)
    .filter((r) => r.code || r.imageTokens.length || r.messageId) // 排除手工建的空行
    .sort((a, b) => a.regMs - b.regMs);
}

async function createExpressRecord(fields) {
  const cfg = requireExpressTable();
  const res = await client.requestAPI('POST', `/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}/records`, { fields });
  if (res.code !== 0) throw new Error(`快递表写入失败: ${res.msg} (${res.code})`);
  return (res.data && res.data.record && res.data.record.record_id) || '';
}

async function updateExpressRecord(recordId, fields) {
  const cfg = requireExpressTable();
  const res = await client.requestAPI(
    'PUT',
    `/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}/records/${recordId}`,
    { fields },
  );
  if (res.code !== 0) throw new Error(`快递表更新失败: ${res.msg} (${res.code})`);
  return res.data;
}

// ---------- 状态（复用 duty 状态文件：window / numbers） ----------

function expressState(s = state.load()) {
  return (s && s.express) || {};
}

function getWindow(s = state.load()) {
  return expressState(s).window || null;
}

function windowActive(win, now = Date.now()) {
  return Boolean(win && now < win.expiresAt);
}

/** 快递群清单：显式 EXPRESS_GROUP_CHAT_IDS 优先，回落值日管辖群 */
function expressChatIds() {
  if (config.express.groupChatIds.length) return config.express.groupChatIds;
  return policy.getPolicy().groupChatIds;
}

function defaultExpressChatId() {
  return expressChatIds()[0] || '';
}

// ---------- 编号：两次播报之间稳定，播报/查询时刷新 ----------

/** 补号：给未编号的未取记录按登记顺序续号（不改已有编号） */
async function ensureNumbers() {
  const items = (await listExpressRecords()).filter((r) => !r.picked);
  const ids = new Set(items.map((r) => r.recordId));
  let numbers = { ...(expressState().numbers || {}) };
  numbers = Object.fromEntries(Object.entries(numbers).filter(([k]) => ids.has(k)));
  let next = items.length ? Math.max(0, ...Object.values(numbers)) + 1 : 1;
  for (const r of items) {
    if (!numbers[r.recordId]) numbers[r.recordId] = next++;
  }
  state.mutate((st) => {
    st.express = st.express || {};
    st.express.numbers = numbers;
  });
  return { items, numbers };
}

/** 刷新编号：未取记录按登记顺序重排 1..N（播报/查询时调用，用户口径「编号以最新播报为准」） */
async function renumber() {
  const items = (await listExpressRecords()).filter((r) => !r.picked);
  const numbers = {};
  items.forEach((r, i) => { numbers[r.recordId] = i + 1; });
  state.mutate((st) => {
    st.express = st.express || {};
    st.express.numbers = numbers;
  });
  return { items, numbers };
}

// ---------- 渲染 ----------

function renderList(items, numbers) {
  return items
    .map((r) => {
      const n = numbers[r.recordId] || '?';
      const time = r.regMs ? new Date(r.regMs + 8 * 3600 * 1000).toISOString().slice(11, 16) : '';
      return `${n}. ${r.code || '（未留码）'}${r.imageTokens.length ? ' 📷' : ''} · ${r.sender}${time ? ` · ${time} 登记` : ''}`;
    })
    .join('\n');
}

function renderOpenGuide(win) {
  const mins = Math.max(1, Math.round((win.expiresAt - win.openedAt) / 60000));
  return [
    `📦 快递登记窗口已开启（${mins} 分钟）！`,
    '有快递要登记的直接发到群里：',
    '· 发「取件码」文字（如 12-3-4567），可跟发一张快递照片',
    '窗口结束后我会每小时播报一次未取清单；取完发「@我 已取编号」或「全部已取」即可。',
  ].join('\n');
}

function renderCloseSummary(win, items, numbers) {
  const inWindow = items.filter((r) => r.regMs >= win.openedAt - 5000 && r.regMs <= win.expiresAt + 60 * 1000);
  if (!inWindow.length) return '📦 登记窗口关闭，本次没有登记到快递。';
  const lines = inWindow
    .map((r) => `${numbers[r.recordId] || '?'}. ${r.code || '（未留码）'}${r.imageTokens.length ? ' 📷' : ''} · ${r.sender}`)
    .join('\n');
  return `📦 登记窗口关闭，本次共登记 ${inWindow.length} 件：\n${lines}\n取完发「@我 已取编号」或「全部已取」，我会每小时播报未取清单。`;
}

function renderBroadcast(items, numbers) {
  return [
    `📦 快递播报｜当前未取 ${items.length} 件：`,
    renderList(items, numbers),
    '取完发「@我 已取编号」或「全部已取」（编号以本条为准，取件后下次播报自动刷新）。',
  ].join('\n');
}

// ---------- 窗口 ----------

let closeTimer = null;

function scheduleClose(win) {
  if (closeTimer) clearTimeout(closeTimer);
  const wait = Math.max(0, win.expiresAt - Date.now()) + 500;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    closeWindowIfDue().catch((err) => console.error('[快递] 窗口关闭播报失败:', err.message));
  }, wait);
  if (closeTimer.unref) closeTimer.unref();
}

/** 窗口到期关闭（定时 + 观察惰性双保险）：关窗摘要给窗口内登记项现场编号 */
async function closeWindowIfDue() {
  const win = getWindow();
  if (!win) return null;
  if (windowActive(win)) return null;
  state.mutate((st) => {
    if (st.express) delete st.express.window;
  });
  try {
    const { items, numbers } = await ensureNumbers();
    await bot.sendTextToChat(win.chatId, renderCloseSummary(win, items, numbers));
  } catch (err) {
    console.error('[快递] 关窗摘要失败:', err.message);
  }
  return win;
}

async function openWindow({ chatId, openId } = {}) {
  const target = chatId || defaultExpressChatId();
  if (!target) {
    return { handled: true, reply: '📦 未配置快递群（EXPRESS_GROUP_CHAT_IDS 或值日管辖群），无法开启登记窗口。' };
  }
  const win = getWindow();
  if (windowActive(win)) {
    const left = Math.max(1, Math.ceil((win.expiresAt - Date.now()) / 60000));
    return { handled: true, reply: `📦 已有登记窗口进行中（约剩 ${left} 分钟），直接把取件码发到群里即可。` };
  }
  const next = {
    chatId: target,
    openedAt: Date.now(),
    expiresAt: Date.now() + config.express.windowMinutes * 60 * 1000,
    openedBy: openId || '',
  };
  state.mutate((st) => {
    st.express = st.express || {};
    st.express.window = next;
  });
  scheduleClose(next);
  // 窗口引导直接发群（人工当下主动触发，不走静默闸门）；reply 留空由本端自送达
  await bot.sendTextToChat(target, renderOpenGuide(next));
  return { handled: true, reply: '' };
}

// ---------- 登记观察（hub 转发的窗口内群消息） ----------

/** 指令/取件词不当取件码登记（@路径已由 hub 走指令转发，这里是防御） */
function isControlText(text) {
  if (!text) return true;
  if (text.startsWith('/')) return true;
  if (PICKUP_ONE_RE.test(text) || text === '全部已取') return true;
  const cmds = policy.getPolicy().p2pCommands;
  return cmds.includes(text) || cmds.includes(text.replace(/^\//, ''));
}

async function registerText({ text, openId, messageId }) {
  const all = await listExpressRecords();
  if (messageId && all.some((r) => r.messageId === messageId)) {
    return { handled: true, reply: '' }; // 重投/重转去重
  }
  const fields = {
    [f().code]: text,
    [f().regTime]: Date.now(),
    [f().picked]: '未取',
    [f().messageId]: messageId || '',
  };
  if (openId) fields[f().senderUser] = [{ id: openId }]; // 发起人（用户主键，飞书自动显示姓名）
  await createExpressRecord(fields);
  console.log(`[快递] 已登记取件码「${text}」（${openId ? senderOf(openId) : '未知'}）`);
  return { handled: true, reply: '' };
}

function senderOf(openId) {
  const member = roster.findByOpenId(openId);
  return (member && member.name) || `成员${String(openId).slice(-4)}`;
}

// 同一人的图片补挂按人串行化（附件字段整列覆盖，并发读-改-写会互相丢图）
const imageLocks = new Map();

function withImageLock(key, fn) {
  const prev = imageLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  imageLocks.set(key, next.catch(() => {}));
  return next;
}

async function observeImage({ imageKey, openId, messageId }) {
  if (!imageKey) return { handled: true, reply: '' };
  return withImageLock(openId || 'anon', async () => {
    const buf = await client.downloadImage(messageId, imageKey);
    const fileToken = await client.uploadMediaToBitable(buf, `express_${Date.now()}_${String(messageId || '').slice(-8) || 'img'}.jpg`);
    const all = await listExpressRecords();
    const win = getWindow();

    // 配对：本窗口内本人最新一条「无图」记录补图；没有则新建纯图片记录
    const candidate = all
      .filter((r) => !r.picked && !r.imageTokens.length && r.senderOpenId === (openId || '')
        && r.regMs >= (win ? win.openedAt : 0) - 5000)
      .pop();
    if (candidate) {
      await updateExpressRecord(candidate.recordId, { [f().image]: [{ file_token: fileToken }] });
      console.log(`[快递] 照片已补进「${candidate.code || '（未留码）'}」`);
      return { handled: true, reply: '' };
    }

    if (messageId && all.some((r) => r.messageId === messageId)) {
      return { handled: true, reply: '' };
    }
    const fields = {
      [f().image]: [{ file_token: fileToken }],
      [f().regTime]: Date.now(),
      [f().picked]: '未取',
      [f().messageId]: messageId || '',
    };
    if (openId) fields[f().senderUser] = [{ id: openId }];
    await createExpressRecord(fields);
    console.log(`[快递] 已登记纯图片快递（${openId ? senderOf(openId) : '未知'}），待补取件码`);
    return { handled: true, reply: '' };
  });
}

/**
 * 窗口观察入口（hub 对快递群非@消息的观察转发：{type:'express_observe', text?, imageKey?, openId, chatId, messageId}）
 * 无窗口/非窗口群一律静默忽略——不产生任何群噪音
 */
async function observe(payload = {}) {
  try {
    await closeWindowIfDue();
    const win = getWindow();
    if (!windowActive(win)) return { handled: true, reply: '' };
    if (payload.chatId && win.chatId !== payload.chatId) return { handled: true, reply: '' };
    if (payload.imageKey) return await observeImage(payload);
    const text = String(payload.text || '').trim();
    if (!text || isControlText(text)) return { handled: true, reply: '' };
    return await registerText({ text, openId: payload.openId, messageId: payload.messageId });
  } catch (err) {
    console.error('[快递] 窗口登记失败:', err.message);
    return { handled: true, reply: '' }; // 观察通道静默失败，不打扰群
  }
}

// ---------- 取件确认与清单 ----------

async function markPicked(record) {
  await updateExpressRecord(record.recordId, {
    [f().picked]: '已取',
    [f().pickedAt]: Date.now(),
  });
}

/**
 * 取件确认：arg = ''（仅一件时生效）/ 'n'（编号）/ 'all'
 * 编号按最后一次播报/查询的快照对账（两次播报之间稳定）
 */
async function handlePickup({ arg = '' } = {}) {
  const { items, numbers } = await ensureNumbers();
  if (!items.length) return { handled: true, reply: '📦 当前没有未取快递。' };
  const listText = renderList(items, numbers);

  if (arg === 'all') {
    for (const r of items) await markPicked(r);
    console.log(`[快递] 全部已取（${items.length} 件）`);
    return { handled: true, reply: `✅ 已把 ${items.length} 件快递全部记为已取，辛苦了！` };
  }

  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n <= 0) {
    if (items.length === 1) {
      await markPicked(items[0]);
      return { handled: true, reply: `✅ 唯一一件（${items[0].code || '未留码'}）已记为已取，辛苦了！` };
    }
    return { handled: true, reply: `📦 当前有 ${items.length} 件未取，请带编号回复（如「已取1」）：\n${listText}\n或回复「全部已取」。` };
  }

  const rec = items.find((r) => numbers[r.recordId] === n);
  if (!rec) {
    return { handled: true, reply: `❌ 没有编号 ${n} 的未取快递（编号可能已刷新）。当前未取：\n${listText}` };
  }
  await markPicked(rec);
  const remain = items.length - 1;
  console.log(`[快递] 编号 ${n}（${rec.code || '未留码'}）已取`);
  return {
    handled: true,
    reply: `✅ 编号 ${n}（${rec.code || '未留码'}）已记为已取。${remain ? `剩余 ${remain} 件未取，编号以下次播报/查询为准。` : '全部取完啦，辛苦！'}`,
  };
}

/** 查询当前快递（查询即刷新编号） */
async function queryPending() {
  const { items, numbers } = await renumber();
  if (!items.length) return { handled: true, reply: '📦 当前没有未取快递。' };
  return {
    handled: true,
    reply: `📦 当前未取 ${items.length} 件：\n${renderList(items, numbers)}\n取完发「@我 已取编号」或「全部已取」。`,
  };
}

/**
 * 每小时整点播报（cron，过静默闸门）：无未取跳过不发；
 * 冲刷补发时以补发时刻最新数据重查（renumber 在发送前执行）
 */
async function broadcastPending({ dryRun = false } = {}) {
  const { items, numbers } = await renumber();
  if (!items.length) {
    console.log('[快递播报] 当前无未取快递，跳过');
    return { skipped: true, reason: 'empty' };
  }
  const text = renderBroadcast(items, numbers);
  if (dryRun) return { skipped: false, dryRun: true, count: items.length, text };
  const targets = expressChatIds();
  if (!targets.length) {
    console.warn('[快递播报] 未配置快递群（EXPRESS_GROUP_CHAT_IDS），播报跳过');
    return { skipped: true, reason: 'no_group' };
  }
  for (const chatId of targets) {
    await bot.sendTextToChat(chatId, text);
  }
  console.log(`[快递播报] 已播报未取 ${items.length} 件 → ${targets.length} 个群`);
  return { skipped: false, count: items.length, groups: targets.length };
}

/** 指令路由（assistantService 转入；raw 已去 / 前缀） */
async function handleCommand(raw, payload = {}) {
  switch (raw) {
    case '快递助手':
      return { handled: true, reply: HELP_TEXT };
    case '快递':
      return openWindow({ chatId: payload.chatType === 'group' ? payload.chatId : '', openId: payload.openId });
    case '查询当前快递':
      return queryPending();
    default: {
      if (raw === '全部已取') return handlePickup({ arg: 'all' });
      const m = raw.match(PICKUP_ONE_RE);
      if (m) return handlePickup({ arg: m[1] || '' });
      return { handled: false, reply: '' };
    }
  }
}

/** 图片载荷入口（hub 转发：群图片 → 窗口登记；无窗口静默） */
async function handleImagePayload(payload = {}) {
  try {
    return await observeImage(payload);
  } catch (err) {
    console.error('[快递] 图片登记失败:', err.message);
    return { handled: true, reply: '' }; // 群图片不打扰；p2p 值日照片不经过此路径
  }
}

module.exports = {
  HELP_TEXT,
  handleCommand,
  handleImagePayload,
  observe,
  openWindow,
  queryPending,
  handlePickup,
  broadcastPending,
  closeWindowIfDue,
  ensureNumbers,
  renumber,
};
