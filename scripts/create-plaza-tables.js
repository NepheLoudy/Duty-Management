/**
 * 动态广场看板建表脚本（一次性、幂等）：在「机器人项目看板」多维表格里创建
 *   1. 动态广场      —— 各机器人事件流（标题/来源机器人/事件类型/数量/链接/动态时间）
 *   2. 网关日活跃    —— gateway usage 日汇总（日期/总消息数/活跃人数/功能数；
 *                      口径=机器人交互。「网关功能使用/网关队员活跃」两表已下线，
 *                      2026-09-13 用户拍板只留日活跃单表）
 * 已存在的表/字段跳过；结束时打印各表 table_id（供各仓 .env 配置）。
 * 运行：node scripts/create-plaza-tables.js
 */
const path = require('path');
const fs = require('fs');
const { requestAPI } = require('../src/feishu/client');
const bitable = require('../src/feishu/bitable');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const APP_TOKEN = process.env.PLAZA_BITABLE_APP_TOKEN || process.env.DUTY_BITABLE_APP_TOKEN;
if (!APP_TOKEN) {
  console.error('未配置 PLAZA_BITABLE_APP_TOKEN / DUTY_BITABLE_APP_TOKEN');
  process.exit(1);
}

// 字段类型：1 文本 / 2 数字 / 3 单选 / 15 链接 / 1001 创建时间
const TABLES = [
  {
    name: '动态广场',
    primaryName: '标题',
    fields: [
      { field_name: '来源机器人', type: 3, property: { options: ['hub', 'ticket-bot', 'bambu', 'duty-bot', 'gateway'].map((n) => ({ name: n })) } },
      { field_name: '事件类型', type: 3, property: { options: ['工单播报', '工单接单', '工单结单', '审批自动通过', '打印排队', '打印开始', '打印完成', '打印失败', '值日完成', '值日请假', 'DDL 播报'].map((n) => ({ name: n })) } },
      { field_name: '数量', type: 2, property: { formatter: '0' } },
      { field_name: '链接', type: 15 },
      { field_name: '动态时间', type: 1001 },
    ],
  },
  { name: '网关日活跃', primaryName: '日期', fields: [
    { field_name: '总消息数', type: 2, property: { formatter: '0' } },
    { field_name: '活跃人数', type: 2, property: { formatter: '0' } },
    { field_name: '功能数', type: 2, property: { formatter: '0' } },
  ] },
  // 「快递」表（2026-09-17 快递助手）：用户手工建（发起人=用户主键/快递内容=附件/
  // 取件码/是否取件 未取·已取），脚本只幂等补缺失列（登记时间/取件时间/消息ID）；
  // /快递 窗口登记 → 每小时未取播报 → 「已取n/全部已取」确认回写
  { name: '快递', primaryName: '发起人', fields: [
    { field_name: '登记时间', type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
    { field_name: '取件时间', type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm' } },
    { field_name: '消息ID', type: 1 },
  ] },
];

async function listTables() {
  const res = await requestAPI('GET', `/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`);
  if (res.code !== 0) throw new Error(`拉表清单失败: ${res.msg} (${res.code})`);
  return res.data.items || [];
}

async function listFields(tableId) {
  const res = await requestAPI('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields?page_size=100`);
  if (res.code !== 0) throw new Error(`拉字段失败: ${res.msg} (${res.code})`);
  return res.data.items || [];
}

(async () => {
  const existing = await listTables();
  const byName = new Map(existing.map((t) => [t.name, t.table_id]));
  const result = {};

  for (const spec of TABLES) {
    let tableId = byName.get(spec.name);
    if (!tableId) {
      try {
        tableId = await bitable.createTable(APP_TOKEN, spec.name);
        console.log(`✓ 建表「${spec.name}」: ${tableId}`);
      } catch (err) {
        // 表不在列表但建同名表报 TableNameDuplicated = 表已被删进回收站（删除表名仍占位，
        // 2026-09-17 动态广场实测如此）：大声告警并跳过，不阻断其余表
        if (String(err.message).includes('TableNameDuplicated') || String(err.message).includes('1254013')) {
          console.error(`⛔ 表「${spec.name}」不在 base 且无法重建（重名，多半在回收站）——请到多维表格回收站恢复后重跑`);
          result[spec.name] = '(missing-in-trash)';
          continue;
        }
        throw err;
      }
    } else {
      console.log(`• 表「${spec.name}」已存在: ${tableId}`);
    }
    result[spec.name] = tableId;

    // 主键（建表自带文本主键）改名（飞书「更新字段」接口是 PUT，不是 PATCH）
    let fields = await listFields(tableId);
    const primary = fields.find((f) => f.is_primary);
    if (primary && primary.field_name !== spec.primaryName) {
      const res = await requestAPI(
        'PUT',
        `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields/${primary.field_id}`,
        { field_name: spec.primaryName, type: primary.type, property: primary.property, ui_type: primary.ui_type }
      );
      if (res.code !== 0) throw new Error(`主键改名失败: ${res.msg} (${res.code})`);
      console.log(`  ✓ 主键改名「${spec.primaryName}」`);
    }

    // 补齐缺失字段
    fields = await listFields(tableId);
    const names = new Set(fields.map((f) => f.field_name));
    for (const field of spec.fields) {
      if (names.has(field.field_name)) continue;
      await bitable.createField(APP_TOKEN, tableId, field);
      console.log(`  ✓ 字段「${field.field_name}」`);
    }
  }

  const out = { appToken: APP_TOKEN, tables: result };
  fs.writeFileSync(path.join(__dirname, 'plaza-tables.json'), JSON.stringify(out, null, 2));
  console.log('\n全部就绪。table_id 清单（已写入 scripts/plaza-tables.json，供各仓 .env 配置）：');
  console.log(JSON.stringify(result, null, 2));
})().catch((err) => {
  console.error('建表失败:', err.message);
  process.exit(1);
});
