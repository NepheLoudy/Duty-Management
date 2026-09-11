/**
 * M0 建表/校验脚本（值日多维表格）
 *
 * 用法：
 *   npm run table:check            校验 .env 已配置表格的字段是否符合约定（读验证）
 *   npm run table:create           自动新建一个 Bitable + 排班表（写 .env 建议值打印到终端）
 *
 * 字段约定（名称可在 .env 覆盖，此处按 config.fields 默认值）：
 *   人员(user) 姓名(text,主键) 日期(date) 岗位(单选：总负责/工位区/装配区)
 *   凭证-负责/凭证-工位/凭证-装配(附件×3) 完成状态(单选：已做完/已请假/未做完)
 *   当日总状态(单选：今日完成值日)
 */
const config = require('../src/config');
const bitable = require('../src/feishu/bitable');

const TYPE_NAMES = { 1: '文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框', 11: '人员', 15: '超链接', 17: '附件', 18: '单向关联', 19: '查找引用', 20: '公式', 21: '双向关联', 22: '地理位置', 23: '群组', 1001: '创建时间' };

function expectedFields() {
  return [
    { field_name: config.fields.name, type: 1, primary: true },
    { field_name: config.fields.user, type: 11 },
    { field_name: config.fields.date, type: 5 },
    {
      field_name: config.fields.position, type: 3,
      options: ['总负责', '工位区', '装配区'],
    },
    { field_name: config.fields.receipts['总负责'], type: 17 },
    { field_name: config.fields.receipts['工位区'], type: 17 },
    { field_name: config.fields.receipts['装配区'], type: 17 },
    {
      field_name: config.fields.status, type: 3,
      options: [config.status.DONE, config.status.LEAVE, config.status.MISS],
    },
    { field_name: config.fields.dayStatus, type: 3, types: [1, 3], options: [config.dayStatusDone] }, // 生产表为文本列，单选亦可
  ];
}

async function check() {
  console.log(`校验表格：app_token=${config.bitable.appToken || '(未配置)'} table_id=${config.bitable.tableId || '(未配置)'}`);
  if (!config.bitable.appToken || !config.bitable.tableId) {
    console.error('❌ 请先在 .env 配置 DUTY_BITABLE_APP_TOKEN / BITABLE_DUTY_TABLE_ID（或运行 npm run table:create）');
    process.exit(1);
  }

  const fields = await bitable.listFields();
  const byName = new Map(fields.map((f) => [f.field_name, f]));

  let missing = 0;
  let wrongType = 0;
  for (const exp of expectedFields()) {
    const actual = byName.get(exp.field_name);
    if (!actual) {
      console.error(`❌ 缺字段「${exp.field_name}」（应为 ${TYPE_NAMES[exp.type]}${exp.options ? `：${exp.options.join('/')}` : ''}）`);
      missing += 1;
      continue;
    }
    const expectTypes = exp.types || [exp.type];
    if (!expectTypes.includes(actual.type)) {
      console.error(`❌ 字段「${exp.field_name}」类型不符：期望 ${expectTypes.map((t) => TYPE_NAMES[t]).join(' 或 ')}，实际 ${TYPE_NAMES[actual.type] || actual.type}`);
      wrongType += 1;
    } else {
      const options = actual.property?.options?.map((o) => o.name) || [];
      if (exp.options && actual.type === 3 && exp.options.some((o) => !options.includes(o))) {
        console.warn(`⚠️ 单选「${exp.field_name}」缺选项：${exp.options.filter((o) => !options.includes(o)).join('/')}（运行时写入会自动带出，建议补全）`);
      } else {
        console.log(`✓ ${exp.field_name}（${TYPE_NAMES[actual.type]}）`);
      }
    }
  }

  const extra = fields.filter((f) => !expectedFields().some((e) => e.field_name === f.field_name));
  for (const f of extra) console.log(`- 表内多余字段「${f.field_name}」（忽略）`);

  const records = await bitable.listAllRecords();
  console.log(`\n读取验证：共 ${records.length} 条记录。`);

  if (missing > 0 || wrongType > 0) {
    console.error(`\n❌ 校验未通过：缺 ${missing} 个字段、${wrongType} 个类型不符。请按上面提示修正表格，或 npm run table:create 重建。`);
    process.exit(1);
  }
  console.log('\n✅ 表格校验通过：duty-bot 可读写该表（M0 表格项完成）。');
}

async function create() {
  console.log('创建值日多维表格…');
  const appToken = await bitable.createBaseApp('值日排班表');
  console.log(`✓ base app_token: ${appToken}`);
  const tableId = await bitable.createTable(appToken, '排班');
  console.log(`✓ table_id: ${tableId}`);

  // 建表自带默认文本主键，直接改名为「姓名」
  const fields = await (async () => {
    const { requestAPI } = require('../src/feishu/client');
    const res = await requestAPI('GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
    if (res.code !== 0) throw new Error(`拉取字段失败: ${res.msg} (code: ${res.code})`);
    return res.data?.items || [];
  })();
  const primaryKey = fields.find((f) => f.is_primary && f.type === 1) || fields.find((f) => f.type === 1);
  if (primaryKey && primaryKey.field_name !== config.fields.name) {
    await bitable.renameField(appToken, tableId, primaryKey.field_id, config.fields.name);
    console.log(`✓ 主键字段已改名「${config.fields.name}」`);
  }

  const toCreate = expectedFields().filter((e) => !e.primary);
  for (const exp of toCreate) {
    const payload = { field_name: exp.field_name, type: exp.type };
    if (exp.type === 3) payload.property = { options: exp.options.map((name) => ({ name })) };
    if (exp.type === 5) payload.property = { date_formatter: 'yyyy-MM-dd', auto_fill: false };
    if (exp.type === 11) payload.property = { multiple: true };
    await bitable.createField(appToken, tableId, payload);
    console.log(`✓ 字段「${exp.field_name}」（${TYPE_NAMES[exp.type]}）`);
  }

  console.log('\n===== 请把以下两行写进 .env（本地与 NAS 同源，勿提交 git）=====');
  console.log(`DUTY_BITABLE_APP_TOKEN=${appToken}`);
  console.log(`BITABLE_DUTY_TABLE_ID=${tableId}`);
  console.log('\n建好后可用 npm run table:check 复核，并确认应用已获得该表权限（把表添加给应用或建在应用可见的文件夹）。');
}

(async () => {
  try {
    if (process.argv.includes('--create')) {
      await create();
    } else {
      await check();
    }
  } catch (err) {
    console.error('\n❌ 失败:', err.message);
    process.exit(1);
  }
})();
