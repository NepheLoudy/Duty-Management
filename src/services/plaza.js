const config = require('../config');
const { requestAPI } = require('../feishu/client');

// ============================================================
// 动态广场事件流（机器人项目看板「动态广场」表）：
// 值日完成/请假等事件落一行，供多维表格仪表盘/时间线展示。
// 只观察不阻塞：写失败仅 warn，绝不影响主流程；未配置表时整体静默。
// ============================================================

const SOURCE = 'duty-bot';

function enabled() {
  return Boolean(config.plaza && config.plaza.appToken && config.plaza.tableId);
}

async function append({ event, title, count, link } = {}) {
  if (!enabled() || !event || !title) return;
  try {
    const res = await requestAPI(
      'POST',
      `/bitable/v1/apps/${config.plaza.appToken}/tables/${config.plaza.tableId}/records`,
      {
        fields: {
          '标题': String(title).slice(0, 500),
          '来源机器人': SOURCE,
          '事件类型': event,
          ...(count != null ? { '数量': count } : {}),
          ...(link ? { '链接': { link } } : {}),
        },
      }
    );
    if (res.code !== 0) throw new Error(`${res.msg} (${res.code})`);
  } catch (err) {
    console.warn('[动态广场] 写入失败（忽略）:', err.message);
  }
}

module.exports = { append };
