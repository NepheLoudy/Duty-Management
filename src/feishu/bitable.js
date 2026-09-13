const config = require('../config');
const { requestAPI } = require('./client');

/**
 * 多维表格读写层（排班表是本项目唯一的数据存储，单一事实来源）。
 * 记录字段：人员(user) 姓名(text) 日期(date) 岗位(singleSelect)
 *           凭证-负责/凭证-工位/凭证-装配(attachment ×3)
 *           完成状态(singleSelect) 当日总状态(singleSelect)
 */

function requireConfig() {
  if (!config.bitable.appToken || !config.bitable.tableId) {
    throw new Error('未配置值日多维表格 (DUTY_BITABLE_APP_TOKEN/BITABLE_DUTY_TABLE_ID)');
  }
}

/** 拉取排班表全部记录（自动翻页） */
async function listAllRecords() {
  requireConfig();
  const records = [];
  let pageToken = '';
  const pageSize = 200;

  do {
    const query = new URLSearchParams({ page_size: String(pageSize) });
    if (pageToken) query.set('page_token', pageToken);

    const res = await requestAPI(
      'GET',
      `/bitable/v1/apps/${config.bitable.appToken}/tables/${config.bitable.tableId}/records?${query.toString()}`
    );

    if (res.code !== 0) {
      throw new Error(`拉取排班表记录失败: ${res.msg} (code: ${res.code})`);
    }

    for (const item of res.data?.items || []) {
      records.push({ record_id: item.record_id, fields: item.fields });
    }

    pageToken = res.data?.has_more ? (res.data.page_token || '') : '';
  } while (pageToken);

  return records;
}

/** 批量新建记录（自动按 50 条分片；fieldsList 为 [{fields: {...}}]） */
async function batchCreateRecords(fieldsList) {
  requireConfig();
  const recordIds = [];
  const CHUNK = 50;

  for (let i = 0; i < fieldsList.length; i += CHUNK) {
    const chunk = fieldsList.slice(i, i + CHUNK);
    const res = await requestAPI(
      'POST',
      `/bitable/v1/apps/${config.bitable.appToken}/tables/${config.bitable.tableId}/records/batch_create`,
      // chunk 元素已是 {fields:{...}} 记录形状(2026-09-14 修复:原 map 再包一层导致 fields 双层,飞书报 FieldNameNotFound)
      { records: chunk }
    );
    if (res.code !== 0) {
      throw new Error(`批量写入排班记录失败: ${res.msg} (code: ${res.code})`);
    }
    for (const r of res.data?.records || []) recordIds.push(r.record_id);
  }

  return recordIds;
}

/** 更新单条记录（部分字段） */
async function updateRecord(recordId, fields) {
  requireConfig();
  const res = await requestAPI(
    'PUT',
    `/bitable/v1/apps/${config.bitable.appToken}/tables/${config.bitable.tableId}/records/${recordId}`,
    { fields }
  );
  if (res.code !== 0) {
    throw new Error(`更新排班记录失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

/** 字段清单（init-duty-table 校验/建表用） */
async function listFields() {
  requireConfig();
  const res = await requestAPI(
    'GET',
    `/bitable/v1/apps/${config.bitable.appToken}/tables/${config.bitable.tableId}/fields?page_size=100`
  );
  if (res.code !== 0) {
    throw new Error(`拉取字段清单失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data?.items || [];
}

// ---------- 以下仅供 scripts/init-duty-table.js 建表使用 ----------

/** 新建多维表格 base（落在应用自身云空间根目录），返回 app_token */
async function createBaseApp(name) {
  const res = await requestAPI('POST', '/bitable/v1/apps', { name });
  if (res.code !== 0) {
    throw new Error(`创建多维表格失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data.app.app_token;
}

/** 在 base 下新建数据表，返回 table_id（自带一个默认文本主键字段） */
async function createTable(appToken, name) {
  const res = await requestAPI(
    'POST',
    `/bitable/v1/apps/${appToken}/tables`,
    { table: { name } }
  );
  if (res.code !== 0) {
    throw new Error(`创建数据表失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data.table_id;
}

/** 新增字段（type：1 文本 / 3 单选 / 5 日期 / 11 人员 / 17 附件） */
async function createField(appToken, tableId, field) {
  const res = await requestAPI(
    'POST',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
    field
  );
  if (res.code !== 0) {
    throw new Error(`创建字段「${field.field_name}」失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

/** 重命名字段（把建表自带的默认文本主键改成「姓名」） */
async function renameField(appToken, tableId, fieldId, fieldName) {
  const res = await requestAPI(
    'PATCH',
    `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`,
    { field_name: fieldName }
  );
  if (res.code !== 0) {
    throw new Error(`重命名字段失败: ${res.msg} (code: ${res.code})`);
  }
  return res.data;
}

module.exports = {
  listAllRecords,
  batchCreateRecords,
  updateRecord,
  listFields,
  createBaseApp,
  createTable,
  createField,
  renameField,
};
