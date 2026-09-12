// ============================================================
// DDL 冲突提示客户端：查询 hub 当前有「未过期 DDL 逾期确认」的成员名单
// （GET /api/ddl/pending），供 18:30 询问附加冲突提示用。
// 短缓存 + 失联静默降级：查不到就不加提示，绝不影响询问主流程。
// ============================================================

const HUB_SERVICE_URL = process.env.HUB_SERVICE_URL || 'http://localhost:3000';
const CACHE_TTL_MS = 60 * 1000;
const TIMEOUT_MS = 2000;

let cache = { ids: null, fetchedAt: 0 };

async function fetchPendingIds() {
  try {
    const res = await fetch(`${HUB_SERVICE_URL}/api/ddl/pending`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`响应 ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.openIds)) throw new Error('结构异常');
    return data.openIds;
  } catch (err) {
    console.warn('[DDL冲突] 查询 hub 待确认名单失败（询问不加冲突提示）:', err.message);
    return null;
  }
}

/**
 * 该成员当前是否有未过期的 DDL 逾期确认（用于询问窗口冲突提示）
 * @returns {Promise<boolean>} 查询失败一律 false（降级不加提示）
 */
async function hasPendingDdlConfirm(openId) {
  if (!openId) return false;
  if (!Array.isArray(cache.ids) || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    const ids = await fetchPendingIds();
    cache = { ids, fetchedAt: Date.now() };
  }
  return Array.isArray(cache.ids) ? cache.ids.includes(openId) : false;
}

module.exports = { hasPendingDdlConfirm };
