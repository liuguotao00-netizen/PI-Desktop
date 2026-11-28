/**
 * 查询淘宝秒杀已报商品管理状态计数和风险计数。
 *
 * 来源接口: GET https://sale.taobao.com/extend/api/gpMyItemInfoQueryHttp.json
 *
 * 入参 params:
 *   - timeout?: number 单次请求超时（ms），默认 20000
 *   - origin?: string  可选覆盖 base URL，优先级最高
 *
 * 出参:
 *   { ok, counts:{signedCount,riskCount,...}, riskList, data, raw }
 *   失败: { ok:false, error, httpStatus?, raw?, text? }
 */

// ---- 顶层工具函数（无状态；单函数控制在 50 行以内） ----

function getCookie(name) {
  const parts = (globalThis.document?.cookie || '').split(';');
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return decodeURIComponent(part.slice(index + 1));
  }
  return '';
}

function readEnv(key) {
  try {
    if (typeof process !== 'undefined' && process.env && process.env[key]) return process.env[key];
  } catch (_) { /* 浏览器沙箱无 process，忽略 */ }
  try {
    if (globalThis.__env__ && globalThis.__env__[key]) return globalThis.__env__[key];
  } catch (_) { /* 忽略 */ }
  return '';
}

function resolveOrigin(options) {
  return options?.origin
    || readEnv('TAOBAO_SALE_BASE_URL')
    || readEnv('SALE_API_ORIGIN')
    || 'https://sale.taobao.com';
}

function appendParams(url, params) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return Number(value);
  }
  return undefined;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 单次网络请求 + 结构化返回，包含超时与 JSON 解析容错。
async function requestJsonOnce(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 20000);
  try {
    const resp = await fetch(url.toString(), {
      method: options.method || 'GET',
      credentials: 'include',
      headers: options.headers || { Accept: 'application/json,text/plain,*/*' },
      body: options.body,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; }
    catch (error) {
      return { ok: false, httpStatus: resp.status, error: 'JSON_PARSE_FAILED: ' + error.message, text };
    }
    if (!resp.ok) return { ok: false, httpStatus: resp.status, error: 'HTTP_' + resp.status, raw: json };
    const businessOk = json?.success !== false;
    return {
      ok: businessOk,
      httpStatus: resp.status,
      error: businessOk ? null : (json?.message || json?.errorMessage || json?.errorCode || 'BUSINESS_FAILED'),
      data: json?.data?.data ?? json?.data ?? json,
      raw: json,
    };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'REQUEST_TIMEOUT' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

// 带退避重试的请求：仅对瞬时故障（429/5xx/timeout）自动重试，最多 2 次；其余直接返回。
async function requestJson(url, options = {}) {
  const backoff = options.backoff || [500, 1500, 3000];
  const maxRetries = options.retries ?? 2;
  let attempt = 0;
  while (true) {
    const result = await requestJsonOnce(url, options);
    const status = result.httpStatus;
    const transient = result.error === 'REQUEST_TIMEOUT'
      || status === 429
      || (typeof status === 'number' && status >= 500 && status < 600);
    if (result.ok || !transient || attempt >= maxRetries) return result;
    const wait = backoff[Math.min(attempt, backoff.length - 1)];
    await sleep(wait);
    attempt += 1;
  }
}

async function saleRequest(path, requestParams = {}, options = {}) {
  const token = getCookie('_tb_token_') || globalThis._tb_token_ || '';
  const url = new URL(path, resolveOrigin(options));
  const finalParams = { ...requestParams };
  if (token) finalParams._tb_token_ = token;
  finalParams.__sm_request__ = true;
  appendParams(url, finalParams);
  return requestJson(url, { timeout: options.timeout });
}

function normalizeCounts(data) {
  return {
    signedCount: pickNumber(data, ['signedCount', 'signCount', 'allCount', 'totalCount']),
    riskCount: pickNumber(data, ['riskCount', 'riskItemCount', 'needProcessCount']),
    auditFailCount: pickNumber(data, ['auditFailCount', 'auditFailedCount']),
    auditingCount: pickNumber(data, ['auditingCount', 'auditCount']),
    onsellCount: pickNumber(data, ['onsellCount', 'onlineCount']),
    activityCancelCount: pickNumber(data, ['activityCancelCount', 'cancelCount']),
    endCount: pickNumber(data, ['endCount', 'finishCount']),
  };
}

// ---- 入口 ----

module.exports = async function getLtaoSignedStatusCounts(params = {}) {
  const result = await saleRequest(
    '/extend/api/gpMyItemInfoQueryHttp.json',
    {},
    { timeout: params.timeout, origin: params.origin },
  );
  if (!result.ok) return result;
  const data = result.data || {};
  return {
    ok: true,
    counts: normalizeCounts(data),
    riskList: data.riskList || data.riskItems || [],
    data,
    raw: result.raw,
  };
};
