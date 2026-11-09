// ============================================================
// 三档及格线判定（2026-11-09 曼波定口径：核心 45 / 正式 35 / 梯队 20 小时/周）
// 档位真源 = 27赛季花名册 bitable「三级认定」列（单选：核心/正式/梯队），
// 匹配 open_id 优先（免疫重名）、姓名兜底；花名册外/无档位者不判定（pass 列留空）。
// 判定失败降级 = 不写 pass 列、不炸播报主链（归档链 warn 继续）。
// ============================================================
const config = require('./config');
const { getTenantAccessToken } = require('../feishu/client');
const feishuDoc = require('./feishuDoc');

const OPEN_API = 'https://open.feishu.cn/open-apis';

// 运行时取线（桩测试改 config.passRules 后立即生效，不模块级固化）
function lineForGrade(grade) {
  const r = config.passRules || {};
  if (grade === '核心') return r.core || 0;
  if (grade === '正式') return r.formal || 0;
  if (grade === '梯队') return r.echelon || 0;
  return 0;
}

// 及格判定启用门控：任一及格线 >0 且花名册定位配置齐全
function passEnabled() {
  const r = config.passRules || {};
  return Boolean((r.core || r.formal || r.echelon) && config.gradeRosterWikiToken && config.gradeRosterTableId);
}

let gradeMapCache = { map: null, byName: null, count: 0, loadedAt: 0 };

// 拉花名册建映射（5 分钟缓存——播报/watchdog/补勾共用，防同一小时反复拉表）
async function loadGradeMap({ refresh = false } = {}) {
  if (!refresh && gradeMapCache.map && Date.now() - gradeMapCache.loadedAt < 5 * 60 * 1000) return gradeMapCache;
  const resolved = await feishuDoc.resolveDocToken(config.gradeRosterWikiToken);
  if (resolved.objType && resolved.objType !== 'bitable') {
    throw new Error('花名册节点类型非 bitable（' + resolved.objType + '）——ZKLINK_GRADE_WIKI_TOKEN 指错对象');
  }
  const t = await getTenantAccessToken();
  const call = async (p) => {
    const res = await fetch(OPEN_API + '/bitable/v1/apps/' + resolved.objToken + '/tables/' + config.gradeRosterTableId + p, {
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + t },
    });
    const j = await res.json();
    if (j.code !== 0) {
      const err = new Error('花名册接口错误 ' + j.code + ': ' + (j.msg || ''));
      err.errcode = j.code;
      throw err;
    }
    return j.data;
  };
  const flds = (await call('/fields?page_size=100')).items || [];
  const gradeField = flds.find((f) => f.field_name === '三级认定');
  if (!gradeField) throw new Error('花名册未找到「三级认定」列——确认 ZKLINK_GRADE_TABLE_ID 指向 27赛季花名册');
  const userField = flds.find((f) => f.type === 11); // 「人员」列：open_id 精确匹配优先
  const nameField = flds.find((f) => f.field_name === '姓名');
  const byOpenId = new Map();
  const byName = new Map();
  let pageToken = '';
  let count = 0;
  do {
    const data = await call('/records?page_size=500' + (pageToken ? '&page_token=' + pageToken : ''));
    for (const r of (data.items || [])) {
      const f = r.fields || {};
      const grade = typeof f['三级认定'] === 'string' ? f['三级认定'].trim() : '';
      if (!grade) continue; // 无档位行不进映射
      count++;
      const ou = userField ? (((f[userField.field_name] || [])[0] || {}).id || '') : '';
      if (ou) byOpenId.set(String(ou), grade);
      const nm = nameField && typeof f[nameField.field_name] === 'string' ? f[nameField.field_name].trim() : '';
      if (nm) byName.set(nm, grade);
    }
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken);
  gradeMapCache = { map: byOpenId, byName, count, loadedAt: Date.now() };
  return gradeMapCache;
}

// 单人判定：u={name, openId, totalMs}；返回 null=不判定（花名册外/无档位），否则 {grade, lineHours, pass}
function judgePass(u, gradeMap) {
  if (!gradeMap || !gradeMap.map) return null;
  const grade = (u.openId && gradeMap.map.get(String(u.openId)))
    || (u.name && gradeMap.byName.get(String(u.name).trim()))
    || null;
  if (!grade) return null;
  const lineHours = lineForGrade(grade);
  if (!lineHours) return null; // 该档未配及格线=不判定
  return { grade: grade, lineHours: lineHours, pass: (Number(u.totalMs) || 0) >= lineHours * 3600 * 1000 };
}

module.exports = { lineForGrade, passEnabled, loadGradeMap, judgePass };
