/**
 * 花费汇总（各营销场景花费分布） (rptType: account)
 *
 * 页面地址: https://one.alimama.com/index.html#!/report/account?rptType=account
 *
 * 本文件保留原项目报表实现，后续直接维护当前 JS。
 *    接口、参数和分页规则沿用原项目。
 *    行为等价对象：skill alimama-report/scripts/report-charge-sum.js（手写版）。
 *
 * 采集模板来源: report/query.json POST
 * 支持三种查询模式:
 *   - "sum"   汇总数据 (queryDomains=["account"])
 *   - "trend" 趋势数据 (queryDomains=["date"])
 *   - "list"  列表数据 (queryDomains=["scene"], 分页)
 *
 * 参数说明:
 *   mode        — "sum" | "trend" | "list"，默认 "list"
 *   startTime   — 开始日期 "YYYY-MM-DD"，默认 7天前
 *   endTime     — 结束日期 "YYYY-MM-DD"，默认 昨天
 *   queryFieldIn— 查询字段数组，默认为该报表的全量字段
 *   splitType   — "day" | "hour"，默认 "day"
 *   effectEqual — 转化统计周期，默认 15
 *   unifyType   — 转化统计口径 "zhai"(窄) | "mta"(全)，默认 "zhai"
 *   pageSize    — 分页大小 (list 模式)，默认 20
 *   offset      — 分页偏移 (list 模式)，默认 0
 *   vsType      — 周期对比 "off" | "day" | "week" | "month"，默认 "week"
 *   vsTime      — 对比基准日期，默认同 endTime
 */

// ═══════════ 工厂核心（原项目内联实现）═══════════
function createReportScript(CONFIG) {
  async function queryReport(params = {}) {
    const { csrfId, loginPointId } = await checkAccess();

    const now = new Date();
    const fmt = (d) => d.toISOString().split('T')[0];
    const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return fmt(d); };

    const mode        = params.mode || 'list';
    const startTime   = params.startTime || daysAgo(CONFIG.defaults.startDaysAgo);
    const endTime     = params.endTime   || daysAgo(CONFIG.defaults.endDaysAgo);
    const splitType   = params.splitType || CONFIG.defaults.splitType;
    const effectEqual = params.effectEqual ?? 15;
    const unifyType   = params.unifyType || 'zhai';
    const queryFieldIn = params.queryFieldIn || CONFIG.fields;
    const vsType      = params.vsType || 'week';
    const vsTime      = params.vsTime || endTime;

    // 公共请求体（baseExtras 合入位置与 skill 手写版一致：vsTime 之后、bizCode 之前）
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
      vsType,
      vsTime,
    }, CONFIG.baseExtras, {
      bizCode: 'universalBP',
      csrfId,
      loginPointId,
    });

    let body;
    switch (mode) {
      case 'sum':
        body = Object.assign({}, base, { queryDomains: ['account'] });
        break;
      case 'trend':
        body = Object.assign({}, base, { queryDomains: ['date'], moduleSource: 'foldLine' });
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
    });
    const res = await resp.json();

    return {
      ok: res.info?.ok,
      data: res.data,
      mode,
      rptType: CONFIG.rptType,
    };
  }

  async function checkAccess() {
    const resp = await fetchWithTimeout('/member/checkAccess.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bizCode: 'universalBP' }),
    });
    const res = await resp.json();
    return {
      csrfId: res.data?.accessInfo?.csrfId || '',
      loginPointId: res.data?.loginPointId || '',
    };
  }

  // --- fetchWithTimeout: 为每次 fetch 加 15s AbortController 超时，超时后由外层 auto-retry 兜底 ---
  function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(t));
  }

  // --- auto-retry: page scripts (e.g. fetch patch) may not be ready yet ---
  return async function (...args) {
    for (let _attempt = 0; _attempt <= 2; _attempt++) {
      try {
        return await queryReport(...args);
      } catch (e) {
        if (_attempt >= 2) throw e;
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
      }
    }
  };
}

// ═══════════ 本报表配置（原项目配置）═══════════
var REPORT_CONFIG = {
  "name": "report-charge-sum",
  "title": "花费汇总（各营销场景花费分布）",
  "pageUrl": "https://one.alimama.com/index.html#!/report/account?rptType=account",
  "rptType": "account",
  "listDomains": [
    "scene"
  ],
  "needCountAccelerate": true,
  "baseExtras": {},
  "defaults": {
    "startDaysAgo": 7,
    "endDaysAgo": 1,
    "splitType": "day",
    "forceRealTime": false
  },
  "fields": [
    "charge"
  ]
};

module.exports = createReportScript(REPORT_CONFIG);
