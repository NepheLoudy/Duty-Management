const crypto = require('crypto');

// ============================================================
// 群自定义机器人 webhook 发送层（非对话型，不经应用身份 Open API）
// - 今日值日看板卡片由此通道发出（webhook 等同群凭据，URL 只落 .env）
// - 12:00 看板自动播报（含昨日战报段）同走本通道
// ============================================================

/**
 * 经群自定义机器人 webhook 发送交互卡片
 * @param {string} webhookUrl 自定义机器人地址（…/bot/v2/hook/xxx）
 * @param {string} secret 签名密钥（机器人未开启签名校验时传空串）
 * @param {object} cardContent 卡片结构（与 im API 的 interactive content 同构）
 * @returns {Promise<object>} 机器人返回的完整 JSON
 */
async function sendCardToWebhook(webhookUrl, secret, cardContent) {
  if (!webhookUrl) {
    throw new Error('未配置群自定义机器人 webhook 地址 (DUTY_BOARD_WEBHOOK_URL)');
  }

  const body = { msg_type: 'interactive', card: cardContent };
  if (secret) {
    // 飞书自定义机器人签名规则：key = `${timestamp}\n${secret}`，对空串做 HMAC-SHA256 后 base64
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = crypto
      .createHmac('sha256', `${timestamp}\n${secret}`)
      .update('')
      .digest('base64');
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    // 无超时的 fetch 挂起会拖住事件管道与定时任务；网关/代理错误页非 JSON 时给出可读错误
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);
  // 成功返回 code=0（旧版字段为 StatusCode=0）
  const code = data ? (data.code ?? data.StatusCode) : res.status;
  if (code !== 0) {
    const msg = data
      ? `${data.msg || data.StatusMessage || ''} (code: ${code})`
      : `HTTP ${res.status} 非 JSON 响应`;
    throw new Error(`群自定义机器人 webhook 发送失败: ${msg}`);
  }
  return data;
}

module.exports = { sendCardToWebhook };
