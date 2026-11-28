/**
 * 市场排行 - 商品排行列表
 * GET /mc/mq/mkt/item/offline/rank*.json (sycm.taobao.com)
 *
 * @param {Object} options
 * @param {string} [options.cateId]              - 类目ID；不传时自动选择店铺主营类目下第一个二级类目
 * @param {string|number} [options.cateFlag]     - 类目层级标记；URL 中常见为 2
 * @param {string} [options.dateType='recent7']  - day / recent7 / recent30；week/month 需显式传 dateRange
 * @param {string} [options.dateRange]           - YYYY-MM-DD|YYYY-MM-DD
 * @param {string} [options.rankType='gmv']      - 榜单类型 query 参数；可传：
 *                                                gmv=交易总量
 *                                                growth=交易增速
 *                                                flow=流量总量
 *                                                add=加购收藏
 *                                                newitm_ipv=新品流量
 *                                                refund=优质低退
 * @param {string} [options.priceSeg='']         - 价格带ID；all/customizePrice 会转为空
 * @param {string} [options.minPrice='']         - 自定义价格下限
 * @param {string} [options.maxPrice='']         - 自定义价格上限
 * @param {string|number} [options.sellerType='-1'] - -1=全部 0=淘宝 1=天猫
 * @param {string} [options.keyWord='']          - 商品关键词筛选
 * @param {string} [options.order]               - flow/add 支持副指标排序；页面默认传空字符串
 * @param {string} [options.orderBy]             - flow/add 支持副指标排序；页面默认传空字符串
 * @param {number} [options.page=1]
 * @param {number} [options.pageSize=10]         - 单页最大 20；超过时脚本按 20 请求
 * @param {number} [options.targetTopN]          - 需要覆盖的榜单名次，如 300；传入后按固定页数强制翻页
 * @param {number} [options.maxPages]            - 最多强制查询页数；不依赖 hasMore
 * @returns {Promise<{cateId, cateFlag, dateRange, dateType, page, pageSize, recordCount, items, raw}>}
 */
"use strict";

const MAX_PAGE_SIZE = 20;

module.exports = async function marketItemRank(options = {}) {
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1000) + 2000));
  const category = await resolveCategory(options);
  const cateId = String(options.cateId || category.cateId || "");
  const cateFlag = String(options.cateFlag ?? category.cateFlag ?? "2");
  if (!cateId) throw new Error("cateId is required");

  const dateType = options.dateType || "recent7";
  if (dateType === "today") {
    throw new Error("market-item-rank.js only covers captured offline rank APIs; use day/recent7/recent30/week/month");
  }

  const rankType = options.rankType || "gmv";
  if (rankType === "refund") {
    throw new Error("rankType=refund uses a separate refund API and is not covered by this script");
  }

  const dateRange = options.dateRange || buildDateRange(dateType);
  const config = getRankConfig(rankType, options.indexCode);
  const priceSeg = ["all", "customizePrice"].includes(String(options.priceSeg || ""))
    ? ""
    : (options.priceSeg || "");
  const page = positiveInteger(options.page, 1);
  const requestedPageSize = positiveInteger(options.pageSize, 10);
  const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE);
  const targetTopN = positiveInteger(options.targetTopN || options.topN, 0);
  const maxPages = positiveInteger(options.maxPages, targetTopN ? Math.ceil(targetTopN / pageSize) : 1);
  const warnings = [];
  if (requestedPageSize > MAX_PAGE_SIZE) {
    warnings.push(`market-item-rank 的 pageSize 单页最大为 ${MAX_PAGE_SIZE}；本次传入 ${requestedPageSize}，已按 ${pageSize} 请求`);
  }
  if (maxPages > 1) {
    warnings.push(`已启用强制翻页：将从 page=${page} 起最多查询 ${maxPages} 页，不依赖 hasMore 判断是否继续`);
  }

  const token = pickLegalityToken();

  const pageResults = [];
  const items = [];
  const seenItemIds = new Set();
  let recordCount = 0;
  let lastPage = page;
  let stoppedBy = "maxPages";

  for (let offset = 0; offset < maxPages; offset += 1) {
    const currentPage = page + offset;
    lastPage = currentPage;
    const pageResult = await fetchRankPage({
      config,
      dateRange,
      dateType,
      pageSize,
      page: currentPage,
      cateId,
      rankType,
      minPrice: options.minPrice,
      maxPrice: options.maxPrice,
      priceSeg,
      sellerType: options.sellerType,
      keyWord: options.keyWord,
      cateFlag,
      order: options.order,
      orderBy: options.orderBy,
      token,
    });
    pageResults.push(pageResult);
    if (pageResult.recordCount) recordCount = pageResult.recordCount;

    if (!pageResult.items.length) {
      stoppedBy = "emptyPage";
      warnings.push(`第 ${currentPage} 页返回空数据，强制翻页停止`);
      break;
    }

    for (const row of pageResult.items) {
      const normalized = normalizeItemRankRow(row);
      const itemId = String(normalized.itemId || "");
      if (itemId && seenItemIds.has(itemId)) continue;
      if (itemId) seenItemIds.add(itemId);
      items.push(normalized);
      if (targetTopN && items.length >= targetTopN) {
        stoppedBy = "targetTopN";
        break;
      }
    }
    if (stoppedBy === "targetTopN") break;
  }

  return {
    cateId,
    cateFlag,
    dateRange,
    dateType,
    rankType,
    page,
    lastPage,
    pageSize,
    requestedPageSize,
    maxPageSize: MAX_PAGE_SIZE,
    targetTopN: targetTopN || null,
    maxPages,
    fetchedPages: pageResults.length,
    stoppedBy,
    returnedCount: items.length,
    recordCount,
    hasMore: null,
    nextPage: null,
    warnings,
    items,
    raw: pageResults.length === 1 ? pageResults[0].raw : { pages: pageResults.map((result) => result.raw) },
  };
};

function getRankConfig(rankType, indexCode) {
  if (rankType === "flow") {
    return {
      path: "/mc/mq/mkt/item/offline/rank/search.json",
      indexCode: indexCode || "uv,searchUv",
      includeSort: true,
    };
  }
  if (rankType === "add") {
    return {
      path: "/mc/mq/mkt/item/offline/rank/purpose.json",
      indexCode: indexCode || "cartByrCnt,cltByrCnt,uv",
      includeSort: true,
    };
  }
  if (rankType === "newitm_ipv") {
    return {
      path: "/mc/mq/mkt/item/offline/rank.json",
      indexCode: indexCode || "uv,payByrCnt,cartByrCnt",
      includeSort: false,
    };
  }
  return {
    path: "/mc/mq/mkt/item/offline/rank.json",
    indexCode: indexCode || "payByrCnt,uv",
    includeSort: false,
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchRankPage(options) {
  const params = new URLSearchParams({
    dateRange: options.dateRange,
    dateType: options.dateType,
    pageSize: String(options.pageSize),
    page: String(options.page),
    cateId: options.cateId,
    rankType: options.rankType,
    minPrice: String(options.minPrice || ""),
    maxPrice: String(options.maxPrice || ""),
    priceSeg: String(options.priceSeg || ""),
    sellerType: String(options.sellerType ?? "-1"),
    keyWord: options.keyWord || "",
    cateFlag: options.cateFlag,
    indexCode: options.config.indexCode,
    marketVersion: "free",
  });

  if (options.config.includeSort) {
    params.set("order", options.order ?? "");
    params.set("orderBy", options.orderBy ?? "");
  } else {
    if (options.order != null) params.set("order", options.order);
    if (options.orderBy != null) params.set("orderBy", options.orderBy);
  }

  if (options.token) {
    params.set("_", String(Date.now()));
    params.set("token", options.token);
  }

  const resp = await fetch(`${options.config.path}?${params.toString()}`, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const body = await resp.json();
  if (body.code !== 0) throw new Error(body.message || `API error code=${body.code}`);

  const inner = body.data || {};
  const list = Array.isArray(inner) ? inner : (inner.data || []);
  return {
    page: options.page,
    items: Array.isArray(list) ? list : [],
    recordCount: Array.isArray(inner) ? list.length : (inner.recordCount || list.length || 0),
    raw: body,
  };
}

async function resolveCategory(options) {
  if (options.cateId) {
    return { cateId: options.cateId, cateFlag: options.cateFlag };
  }

  const treeResp = await fetch("/mc/common/free/getCateInfo.json?marketVersion=free", {
    credentials: "include",
  });
  const treeBody = await treeResp.json();
  const allCates = treeBody.data || [];

  let cateLevel1Id = "";
  try {
    const mainResp = await fetch("/portal/shop/getMainCateInfo.json", { credentials: "include" });
    const mainBody = await mainResp.json();
    cateLevel1Id = mainBody.content?.data?.cateLevel1Id || mainBody.data?.cateLevel1Id || "";
  } catch (e) {
    cateLevel1Id = "";
  }

  let target = cateLevel1Id ? allCates.find((r) => String(r[6]) === String(cateLevel1Id) && r[3] === 2) : null;
  if (!target) {
    const firstL1 = allCates.find((r) => r[3] === 1);
    target = firstL1 ? allCates.find((r) => String(r[6]) === String(firstL1[1]) && r[3] === 2) : null;
  }
  if (!target) return {};
  return { cateId: target[1], cateFlag: target[3] };
}

function buildDateRange(dateType) {
  if (!["day", "recent7", "recent30"].includes(dateType)) {
    throw new Error("dateRange is required when dateType is not day/recent7/recent30");
  }
  const today = new Date();
  const extraOffset = today.getHours() < 8 ? 1 : 0;
  const end = new Date(today - (1 + extraOffset) * 86400000);
  const endStr = end.toISOString().slice(0, 10);
  if (dateType === "recent7") {
    const start = new Date(today - (7 + extraOffset) * 86400000);
    return `${start.toISOString().slice(0, 10)}|${endStr}`;
  }
  if (dateType === "recent30") {
    const start = new Date(today - (30 + extraOffset) * 86400000);
    return `${start.toISOString().slice(0, 10)}|${endStr}`;
  }
  return `${endStr}|${endStr}`;
}

function normalizeItemRankRow(row) {
  const item = row.item || {};
  const shop = row.shop || {};
  return {
    rank: valueOf(row.cateRankId),
    rankCycleCqc: row.cateRankId?.cycleCqc,
    itemId: item.itemId || valueOf(row.itemId),
    title: item.title,
    pictUrl: item.pictUrl,
    detailUrl: item.detailUrl,
    itemUserId: item.userId,
    sellerId: valueOf(row.sellerId) || row.sellerId,
    shopTitle: shop.title,
    shopUrl: shop.shopUrl,
    shopPictureUrl: shop.pictureUrl,
    shopUserId: shop.userId,
    b2CShop: shop.b2CShop,
    coreKeywords: splitKeywords(valueOf(row.coreKeyWord)),
    payByrCnt: valueOf(row.payByrCnt),
    uv: valueOf(row.uv),
    searchUv: valueOf(row.searchUv),
    cartByrCnt: valueOf(row.cartByrCnt),
    cltByrCnt: valueOf(row.cltByrCnt),
    isMonitor: valueOf(row.isMonitor),
    isSelfItem: valueOf(row.isSelfItem),
    raw: row,
  };
}

function valueOf(field) {
  if (field && typeof field === "object" && "value" in field) return field.value;
  return field;
}

function splitKeywords(value) {
  return typeof value === "string" && value
    ? value.split(",").map((word) => word.trim()).filter(Boolean)
    : [];
}

function pickLegalityToken() {
  const meta = (typeof window !== "undefined" && window.metaCacheData) || {};
  const cfg = (typeof window !== "undefined" && window.g_config) || {};
  return meta.legalityToken
    || cfg.token
    || (typeof location !== "undefined" && new URLSearchParams(location.search).get("token"))
    || "";
}
