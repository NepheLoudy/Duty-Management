const config = require('../config');

const BASE_URL = 'https://open.feishu.cn/open-apis';

// tenant_access_token 缓存，避免每次调用都重新获取
let tokenCache = { token: null, expiresAt: 0 };

/**
 * 获取飞书 tenant_access_token（带缓存，提前 60 秒过期）
 */
async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60 * 1000) {
    return tokenCache.token;
  }

  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error('未配置飞书应用凭证 (APP_ID/APP_SECRET)');
  }

  const res = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败: ${data.msg} (code: ${data.code})`);
  }

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + data.expire * 1000,
  };
  return tokenCache.token;
}

/**
 * 调用飞书开放平台 API
 * @param {string} method HTTP 方法
 * @param {string} path 路径（以 / 开头，不含 host）
 * @param {object} body 请求体（GET 时传 null）
 * @returns {Promise<object>} 飞书返回的完整 JSON（含 code/msg/data）
 */
async function requestAPI(method, path, body) {
  const token = await getTenantAccessToken();

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    // 无超时的 fetch 挂起会拖住事件管道与定时任务；网关/代理错误页非 JSON 时给出可读错误
    signal: AbortSignal.timeout(15000),
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  try {
    return await res.json();
  } catch (err) {
    throw new Error(`飞书 API 返回非 JSON 响应 (HTTP ${res.status}): ${path}`);
  }
}

/**
 * 下载 IM 消息图片（二进制）。需应用开通「获取消息中的资源文件」权限。
 * 用户发送的图片不能用 GET /im/v1/images/{image_key}（该接口只能下载机器人
 * 自己上传的图片，飞书对用户图片报 234001），必须走消息资源接口：
 * GET /im/v1/messages/{message_id}/resources/{file_key}?type=image
 */
async function downloadImage(messageId, imageKey) {
  if (!messageId) {
    throw new Error('下载图片失败: 缺少 message_id（消息资源接口必填）');
  }
  const token = await getTenantAccessToken();
  const res = await fetch(
    `${BASE_URL}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
    {
      method: 'GET',
      signal: AbortSignal.timeout(30000),
      headers: { 'Authorization': `Bearer ${token}` },
    }
  );

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || contentType.includes('application/json')) {
    // 出错时飞书返回 JSON 错误体（如权限未开通）
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = `${body.code || res.status}: ${body.msg || ''}`;
    } catch (err) { /* 非 JSON 错误体，保留 HTTP 状态 */ }
    throw new Error(`下载图片失败: ${msg}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) {
    throw new Error('下载图片失败: 空响应');
  }
  return buf;
}

/**
 * 上传媒体到多维表格，返回可直接写入附件字段的 file_token。
 * parent_type=bitable_file（多维表格附件字段），parent_node=多维表格 base 的 app_token。
 * 需应用开通 drive:file:upload（上传、下载文件到云空间）权限。
 */
async function uploadMediaToBitable(buffer, fileName) {
  const token = await getTenantAccessToken();
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', config.bitable.appToken);
  form.append('size', String(buffer.length));
  form.append('file', new Blob([buffer]), fileName);

  const res = await fetch(`${BASE_URL}/drive/v1/medias/upload_all`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!data || data.code !== 0 || !data.data || !data.data.file_token) {
    const msg = data ? `${data.code}: ${data.msg}` : `HTTP ${res.status} 非 JSON 响应`;
    throw new Error(`上传图片到多维表格失败: ${msg}`);
  }
  return data.data.file_token;
}

module.exports = {
  getTenantAccessToken,
  requestAPI,
  downloadImage,
  uploadMediaToBitable,
};
