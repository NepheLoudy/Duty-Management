const config = require('../config');
const bitable = require('../feishu/bitable');
const { toDateStr, shanghaiMidnightMs } = require('../utils/dates');
const { POSITIONS } = require('./scheduleAlgo');

// ============================================================
// 排班表读写层（本项目所有表格 IO 的唯一出口，stub 测试在这里打桩）
// 每日一组 3 条记录（每人一条）；记录字段见 config.fields。
// ============================================================

/** 任意字段值 → 展示文本（text 数组/字符串兜底） */
function fieldText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((seg) => (typeof seg === 'string' ? seg : seg.text || seg.name || '')).join('');
  }
  return String(value);
}

/** 人员字段（User 数组）→ 第一个 open_id */
function fieldFirstUserId(value) {
  if (!Array.isArray(value)) return '';
  return value[0]?.id || '';
}

/** 附件字段 → 附件数组（用于追加前先取现有） */
function fieldAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((a) => a && a.file_token);
}

/** 原始记录 → 归一化结构 */
function normalizeRecord(raw) {
  const f = raw.fields || {};
  const dateMs = Number(f[config.fields.date] || 0);
  const receipts = {};
  for (const pos of POSITIONS) {
    receipts[pos] = fieldAttachments(f[config.fields.receipts[pos]]).length;
  }
  return {
    recordId: raw.record_id,
    fields: f,
    name: fieldText(f[config.fields.name]),
    openId: fieldFirstUserId(f[config.fields.user]),
    dateStr: dateMs ? toDateStr(dateMs) : '',
    position: fieldText(f[config.fields.position]),
    status: fieldText(f[config.fields.status]),
    dayStatus: fieldText(f[config.fields.dayStatus]),
    receiptCounts: receipts,
  };
}

/** 全表归一化记录（按日期升序） */
async function getAllDayRecords() {
  const raws = await bitable.listAllRecords();
  return raws
    .map(normalizeRecord)
    .filter((r) => r.dateStr)
    .sort((a, b) => (a.dateStr < b.dateStr ? -1 : a.dateStr > b.dateStr ? 1 : 0));
}

async function getRecordsByDate(dateStr) {
  const all = await getAllDayRecords();
  return all.filter((r) => r.dateStr === dateStr);
}

/** 表中最后一个已排日期（空表返回 null） */
async function getLastScheduledDateStr() {
  const all = await getAllDayRecords();
  return all.length > 0 ? all[all.length - 1].dateStr : null;
}

/**
 * 新建某日值日记录（每人一条）
 * @param {string} dateStr
 * @param {Array<{member: {name: string, openId?: string}, position: string}>} items
 */
async function createDayRecords(dateStr, items) {
  const dateMs = shanghaiMidnightMs(dateStr);
  const fieldsList = items.map(({ member, position }) => {
    const fields = {
      [config.fields.name]: member.name,
      [config.fields.date]: dateMs,
      [config.fields.position]: position,
    };
    if (member.openId) {
      fields[config.fields.user] = [{ id: member.openId }];
    }
    return { fields };
  });
  if (fieldsList.length === 0) return [];
  return bitable.batchCreateRecords(fieldsList);
}

/** 写单条完成状态（已做完/已请假/未做完；传空串清除） */
async function setStatus(recordId, statusValue) {
  const fields = { [config.fields.status]: statusValue || null };
  return bitable.updateRecord(recordId, fields);
}

/** 当日总状态写回（今日完成值日 / 清除传 null）；三条记录同步写同一值 */
async function setDayStatus(recordIds, value) {
  const fields = { [config.fields.dayStatus]: value || null };
  for (const recordId of recordIds) {
    await bitable.updateRecord(recordId, fields);
  }
}

/**
 * 追加照片凭证到指定岗位附件栏（先读现有附件再合并写入，飞书附件字段是整列覆盖）。
 * 每人只填自己岗位那一列。
 */
async function appendReceipt(recordId, position, fileToken) {
  const all = await getAllDayRecords();
  const record = all.find((r) => r.recordId === recordId);
  const existing = record ? fieldAttachments(record.fields[config.fields.receipts[position]]) : [];
  return bitable.updateRecord(recordId, {
    [config.fields.receipts[position]]: [...existing, { file_token: fileToken }],
  });
}

/**
 * 当日总状态判定：同日 3 条记录中三个附件栏各有 ≥1 个附件，
 * 且 3 条「完成状态」均为已做完 → 今日完成值日；否则 null（保持为空=未完成）。
 * @param {Array<normalizeRecord>} records 当日全部记录
 */
function computeDayStatus(records) {
  if (records.length === 0) return null;
  const allDone = records.every((r) => r.status === config.status.DONE);
  if (!allDone) return null;
  for (const pos of POSITIONS) {
    const hasReceipt = records.some((r) => (r.receiptCounts[pos] || 0) >= 1);
    if (!hasReceipt) return null;
  }
  return config.dayStatusDone;
}

module.exports = {
  fieldText,
  fieldAttachments,
  normalizeRecord,
  getAllDayRecords,
  getRecordsByDate,
  getLastScheduledDateStr,
  createDayRecords,
  setStatus,
  setDayStatus,
  appendReceipt,
  computeDayStatus,
};
