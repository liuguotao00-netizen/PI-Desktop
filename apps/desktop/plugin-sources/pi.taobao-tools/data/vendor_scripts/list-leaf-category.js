/**
 * 数据银行 - 授权叶子类目列表
 *
 * api-id:   api-080
 * method:   GET
 * endpoint: /api/dimension/listLeafCategory（host 来自 config.json，避免硬编码业务域名）
 *
 * 为 inflow-outflow-lost-competitors 的 cate 参数提供可选叶子类目 ID。
 * 脚本职责：只做确定性数据获取与本地过滤，禁止自动重试；失败原样返回，由 Agent 决定兜底。
 *
 * 入参 params:
 *   keyword   {string} 选填，按类目名过滤（本地过滤 cateFullName/cateName）
 *   limit     {number} 选填，最多返回条数（max_items），默认不截断
 *   timeoutMs {number} 选填，fetch 超时毫秒，默认 30000
 *
 * 返回 {ok, total, categories:[{cateId, cateName, cateFullName, cateLevel}]}
 * 失败契约: ok=false + error∈{NETWORK_ERROR, TIMEOUT, HTTP_<code>, PARSE_ERROR, BIZ_ERROR}
 */
module.exports = async function listLeafCategory(params = {}) {
  const p = params || {};
  const CONFIG = tryRequireConfig() || {};
  const endpoint = CONFIG.endpoint;
  if (!endpoint) {
    return { ok: false, error: 'CONFIG_MISSING', message: 'config.json 未加载或缺少 endpoint 字段' };
  }
  const timeoutMs = Number(p.timeoutMs || CONFIG.timeoutMs || 30000);
  const query = {
    path: (CONFIG.paths && CONFIG.paths.listLeafCategory) || '/api/dimension/listLeafCategory',
    isOrderByMainCate: 'true',
    type: 'AUTH_BRAND_LEAF_CATE',
    _: Date.now(),
  };
  const qs = Object.keys(query)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');
  const url = `${endpoint}?${qs}`;

  const csrf =
    (document.querySelector('meta[name=_csrf]') &&
      document.querySelector('meta[name=_csrf]').getAttribute('token')) || '';

  // timeout: AbortController; no retry / no backoff; 429 rate limit / semaphore 由 Agent 串行控制；失败由上游 fallback / 降级
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null; // timeout=timeoutMs
  let resp;
  try {
    // timeout, no-retry, fallback-by-agent
    resp = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: Object.assign({ accept: '*/*' }, csrf ? { 'x-csrf-token': csrf } : {}),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    const isAbort = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
    return { ok: false, error: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR', message: String(e && e.message || e) };
  }
  if (timer) clearTimeout(timer);
  // 校验结果：response.ok / status_code == 200
  if (!resp.ok) return { ok: false, error: 'HTTP_' + resp.status, message: `HTTP ${resp.status}` };
  let body;
  try {
    body = await resp.json();
  } catch (e) {
    return { ok: false, error: 'PARSE_ERROR', message: '响应非 JSON' };
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'INVALID_RESPONSE', message: '响应缺少类目数据，不能当作空列表' };
  }
  if (body.errCode !== 0 && body.errCode != null) {
    return { ok: false, error: 'BIZ_ERROR', errCode: body.errCode, message: body.errMsg || '业务失败' };
  }
  if (!Array.isArray(body.data)) {
    return { ok: false, error: 'INVALID_RESPONSE', message: '响应缺少类目列表，请确认账号权限和接口返回' };
  }

  const leaves = [];
  const walk = (nodes) => {
    (nodes || []).forEach((n) => {
      if (!n) return;
      if (n.leaf && n.cateId) {
        leaves.push({
          cateId: n.cateId,
          cateName: n.cateName,
          cateFullName: n.cateFullName,
          cateLevel: n.cateLevel,
        });
      }
      if (n.children) walk(n.children);
    });
  };
  walk(body.data);

  let categories = leaves;
  if (p.keyword) {
    const kw = String(p.keyword);
    categories = leaves.filter(
      (c) => (c.cateFullName && c.cateFullName.includes(kw)) || (c.cateName && c.cateName.includes(kw))
    );
  }
  // limit / max_items 截断
  if (Number(p.limit) > 0) categories = categories.slice(0, Number(p.limit));

  return { ok: true, total: categories.length, categories };
};

function tryRequireConfig() {
  try {
    // eslint-disable-next-line global-require
    return require('../config.json');
  } catch (_) {
    return null;
  }
}
