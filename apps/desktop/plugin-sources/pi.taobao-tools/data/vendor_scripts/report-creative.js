// @docs README.md#范围与来源
/**
 * 创意报表 (rptType: creative)
 *
 * 页面地址: https://one.alimama.com/index.html#!/report/creative?rptType=creative
 *
 * 按 2026-10-12 宿主创意报表页面的真实请求实现。
 * 原技能中的本文件为空占位；共用报表流程参考 report-area.js。
 * 列表按创意和主体返回，单次只取一页，不生成文件或修改推广。
 *
 * 采集模板来源: report/query.json POST
 * 支持三种查询模式:
 *   - "sum"   汇总数据 (queryDomains=["account"])
 *   - "trend" 趋势数据 (queryDomains=["date"])
 *   - "list"  列表数据 (queryDomains=["creative","promotion"], 分页)
 *
 * 参数说明:
 *   mode        — "sum" | "trend" | "list"，默认 "list"
 *   startTime   — 开始日期 "YYYY-MM-DD"，默认 7天前
 *   endTime     — 结束日期 "YYYY-MM-DD"，默认 昨天
 *   queryFieldIn— 查询字段数组，默认使用实页已验证的 15 项指标
 *   splitType   — "day" | "hour"，默认 "day"
 *   effectEqual — 转化统计周期，默认 15
 *   unifyType   — 转化统计口径 "zhai"(窄) | "mta"(全)，默认 "zhai"
 *   pageSize    — 分页大小 (list 模式)，默认 20
 *   offset      — 分页偏移 (list 模式)，默认 0
 *   vsType      — 周期对比 "off" | "day" | "week" | "month"，默认 "week"（sum/trend）
 *   vsTime      — 对比基准日期，默认同 endTime
 */

// ═══════════ 报表查询（沿用相邻报表的单文件执行方式）═══════════
function createReportScript(CONFIG) {
  async function queryReport(params = {}) {
    const mode = params.mode || 'list';
    if (!['list', 'sum', 'trend'].includes(mode)) throw new Error('mode 必须是 list、sum 或 trend');
    const { csrfId, loginPointId } = await checkAccess();

    const now = new Date();
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return fmt(d); };

    const startTime   = params.startTime || daysAgo(CONFIG.defaults.startDaysAgo);
    const endTime     = params.endTime   || daysAgo(CONFIG.defaults.endDaysAgo);
    const splitType   = params.splitType || CONFIG.defaults.splitType;
    const effectEqual = params.effectEqual ?? 15;
    const unifyType   = params.unifyType || 'zhai';
    const queryFieldIn = params.queryFieldIn || CONFIG.fields;
    const vsType      = params.vsType || 'week';
    const vsTime      = params.vsTime || endTime;

    // 列表不传周期对比参数；汇总和趋势沿用实页的 vsType / vsTime。
    const base = Object.assign({
      rptType: CONFIG.rptType,
      source: 'baseReport',
      fromRealTime: !!CONFIG.defaults.forceRealTime || endTime === fmt(now),
      startTime,
      endTime,
      splitType,
      effectEqual,
      unifyType,
      queryFieldIn,
    }, CONFIG.baseExtras, {
      bizCode: 'universalBP',
      csrfId,
      loginPointId,
    });

    let body;
    switch (mode) {
      case 'sum':
        body = Object.assign({}, base, { queryDomains: ['account'], vsType, vsTime });
        break;
      case 'trend':
        body = Object.assign({}, base, { queryDomains: ['date'], moduleSource: 'foldLine', vsType, vsTime });
        break;
      case 'list':
      default:
        body = Object.assign({}, base, {
          queryDomains: CONFIG.listDomains,
          byPage: true,
          totalTag: true,
          needCountAccelerate: CONFIG.needCountAccelerate !== false,
          byPageWithoutCount: false,
          pageSize: params.pageSize || 20,
          offset: params.offset || 0,
          havingList: params.havingList || [],
        });
        break;
    }

    const resp = await fetchWithTimeout('/report/query.json?csrfId=' + csrfId + '&bizCode=universalBP', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    const res = await resp.json();
    if (typeof res?.info?.ok !== 'boolean' || (res.info.ok && !Array.isArray(res.data?.list))) {
      throw new Error('创意报表响应结构异常');
    }

    return {
      ok: res.info?.ok,
      data: res.data,
      mode,
      rptType: CONFIG.rptType,
      ...(!res.info?.ok ? { info: res.info } : {}),
    };
  }

  async function checkAccess() {
    const resp = await fetchWithTimeout('/member/checkAccess.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bizCode: 'universalBP' }),
      credentials: 'include',
    });
    const res = await resp.json();
    if (res?.info?.ok !== true || !res.data?.accessInfo?.csrfId || !res.data?.loginPointId) {
      throw new Error(`未能获取万相台报表访问权限：${res?.info?.message || '鉴权响应缺少有效凭据'}`);
    }
    return {
      csrfId: res.data.accessInfo.csrfId,
      loginPointId: res.data.loginPointId,
    };
  }

  // --- fetchWithTimeout: 为每次 fetch 加 15s AbortController 超时，超时后由外层 auto-retry 兜底 ---
  function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp;
    }).finally(() => clearTimeout(t));
  }

  // --- auto-retry: page scripts (e.g. fetch patch) may not be ready yet ---
  return async function (...args) {
    for (let _attempt = 0; _attempt <= 2; _attempt++) {
      try {
        return await queryReport(...args);
      } catch (e) {
        if (_attempt >= 2 || /mode 必须|访问权限|响应结构异常|HTTP (?:401|403)|429|风控|安全策略|限流|RISK_CONTROL|LOGIN_REQUIRED/i.test(String(e))) throw e;
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
      }
    }
  };
}

// ═══════════ 创意报表实页配置 ═══════════
var REPORT_CONFIG = {
  "name": "report-creative",
  "title": "创意报表",
  "pageUrl": "https://one.alimama.com/index.html#!/report/creative?rptType=creative",
  "rptType": "creative",
  "listDomains": [
    "creative",
    "promotion"
  ],
  "needCountAccelerate": true,
  "baseExtras": {
    "from": "pcBaseReport"
  },
  "defaults": {
    "startDaysAgo": 7,
    "endDaysAgo": 1,
    "splitType": "day",
    "forceRealTime": false
  },
  "fields": [
    "adPv",
    "click",
    "charge",
    "ctr",
    "ecpc",
    "alipayInshopAmt",
    "alipayInshopNum",
    "cvr",
    "cartInshopNum",
    "itemColInshopNum",
    "shopColDirNum",
    "colNum",
    "itemColInshopCost",
    "roi",
    "newAlipayInshopUvRate"
  ]
};

module.exports = createReportScript(REPORT_CONFIG);
