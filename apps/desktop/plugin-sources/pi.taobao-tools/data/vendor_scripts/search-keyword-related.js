/**
 * 市场-搜索分析 - 相关搜索词(平台算法推荐)
 * GET /mc/mq/mkt/keyword/relate/analysis.json (sycm.taobao.com)
 *
 * 生意参谋「市场 → 搜索排行 → 搜索分析」页的相关词接口(页面可见:
 * 相关热搜词 / 相关蓝海词 两个页签),基于平台相关性算法,与
 * search-keyword-rank 的 keyWord 子串过滤完全不同。
 *
 * 字段说明:
 *   relatedSekeyword  相关搜索词
 *   seIpvUvHits       搜索人气(区间)+ 环比 cycleCrc
 *   clickThroughRate  点击率(%)
 *   payConvRate       支付转化率(区间)
 *   payByrCnt         支付买家数(区间)
 *   simWeight         相关度(蓝海词页签默认排序键)
 *   tmaoClickRatio    天猫商品点击占比
 *
 * @param {Object} options
 * @param {string} options.keyWord            - 种子搜索词(必填)
 * @param {string} [options.dateType='day']   - day / recent7 / recent30
 * @param {string} [options.dateRange]        - YYYY-MM-DD|YYYY-MM-DD(缺省由 dateType 推导当日口径)
 * @param {string} [options.rankType='related'] - related(相关热搜词) / bluesea(相关蓝海词)
 * @param {string} [options.cycleFlag='cycle'] - cycle(环比) / yearOnYear(年同比)
 * @param {string} [options.orderBy='seIpvUvHits'] - seIpvUvHits / clickThroughRate / payConvRate / payByrCnt / simWeight / tmaoClickRatio
 * @param {string} [options.order='desc']
 * @param {number} [options.page=1]
 * @param {number} [options.pageSize=100]     - 实测单页上限 100
 * @returns {Promise<{keyWord, rankType, recordCount, words[]}>}
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;

function qp(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function inferDateRange(dateType) {
  // 与页面行为一致:缺省时按 dateType 推导(近 N 天,截止昨天)
  const day = 24 * 60 * 60 * 1000;
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const end = new Date(Date.now() - day);          // 昨天
  const span = { day: 1, recent7: 7, recent30: 30 }[dateType] || 1;
  const start = new Date(end.getTime() - (span - 1) * day);
  return `${fmt(start)}|${fmt(end)}`;
}

async function default_1(options) {
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1200)));

  const keyWord = options.keyWord;
  if (!keyWord) throw new Error("keyWord 必填(种子搜索词)");

  const dateType = options.dateType || "day";
  const rankType = options.rankType || "related";
  const dateRange = options.dateRange || inferDateRange(dateType);

  const params = qp({
    dateRange,
    dateType,
    pageSize: String(options.pageSize || 100),
    page: String(options.page || 1),
    order: options.order || "desc",
    orderBy: options.orderBy || (rankType === "bluesea" ? "simWeight" : "seIpvUvHits"),
    keyWord,
    cycleFlag: options.cycleFlag || "cycle",
    rankType,
    marketVersion: "free",
  });

  const resp = await fetch(`/mc/mq/mkt/keyword/relate/analysis.json?${params}`, { credentials: 'include' });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(body.message || `API error code=${body.code}`);

  const inner = body.data || {};
  const list = inner.data || [];
  const baseRank = ((Number(options.page) || 1) - 1) * (Number(options.pageSize) || 100);
  return {
    keyWord,
    rankType,
    dateRange,
    recordCount: inner.recordCount || 0,
    words: list.map((w, i) => ({
      rank: baseRank + i + 1,
      relatedSekeyword: w.relatedSekeyword?.value,
      seIpvUvHits: w.seIpvUvHits?.value,
      seIpvUvHitsCrc: w.seIpvUvHits?.cycleCrc,
      clickThroughRate: w.clickThroughRate?.value,
      payConvRate: w.payConvRate?.value,
      payByrCnt: w.payByrCnt?.value,
      payByrCntCrc: w.payByrCnt?.cycleCrc,
      simWeight: w.simWeight?.value,
      tmaoClickRatio: w.tmaoClickRatio?.value,
    })),
  };
}
