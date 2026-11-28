"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;

/**
 * 市场-通用 - 叶子类目名称检索
 * GET /mc/common/free/getCateInfo.json (sycm.taobao.com)
 *
 * 复用可用类目树接口，按类目名称模糊检索（默认仅返回叶子类目），
 * 拿到 cateId 后可传给 market-item-rank.js 等商品排行脚本。
 *
 * 每条原始记录格式:
 *   [parentCateId, cateId, cateName, cateFlag, marketVersion, isLeaf, cateLevel1Id, cateLevel1Name]
 *
 * @param {Object} options
 * @param {string}        options.keyword            - 类目名关键词（必填，模糊匹配 cateName）
 * @param {string|number} [options.cateLevel1Id]     - 限定一级类目范围
 * @param {boolean}       [options.leafOnly=true]    - 是否仅返回叶子类目（isLeaf=Y）
 * @param {boolean}       [options.exact=false]      - 是否按名称精确匹配（默认模糊包含）
 * @param {number}        [options.limit]            - 返回结果数量上限（默认不限制）
 * @returns {Promise<{recordCount, categories[]}>}
 */
async function default_1(options) {
  if (!options || !options.keyword) throw new Error("keyword is required");

  const resp = await fetch("/mc/common/free/getCateInfo.json?marketVersion=free", {
    credentials: "include",
  });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(body.message || `API error code=${body.code}`);

  const raw = body.data || [];
  const all = raw.map((r) => ({
    parentCateId: r[0],
    cateId: r[1],
    cateName: r[2],
    cateFlag: r[3],
    isLeaf: r[5] === "Y",
    cateLevel1Id: r[6],
    cateLevel1Name: r[7],
  }));

  // 用 cateId -> 记录 建立索引，便于沿 parentCateId 回溯完整路径
  const byId = new Map(all.map((c) => [String(c.cateId), c]));

  const keyword = String(options.keyword).trim().toLowerCase();
  const exact = options.exact === true;
  const leafOnly = options.leafOnly !== false;
  const level1Filter = options.cateLevel1Id != null ? Number(options.cateLevel1Id) : null;

  let matches = all.filter((c) => {
    if (leafOnly && !c.isLeaf) return false;
    if (level1Filter != null && c.cateLevel1Id !== level1Filter) return false;
    const name = String(c.cateName || "").toLowerCase();
    return exact ? name === keyword : name.includes(keyword);
  });

  if (options.limit && Number(options.limit) > 0) {
    matches = matches.slice(0, Number(options.limit));
  }

  const categories = matches.map((c) => ({
    cateId: c.cateId,
    cateName: c.cateName,
    cateFlag: c.cateFlag,
    isLeaf: c.isLeaf,
    cateLevel1Id: c.cateLevel1Id,
    cateLevel1Name: c.cateLevel1Name,
    cateFullName: buildFullName(c, byId),
  }));

  return { recordCount: categories.length, categories };
}

// 沿 parentCateId 向上回溯，拼出 "一级 > 二级 > ... > 当前" 的完整类目路径
function buildFullName(node, byId) {
  const names = [];
  let cur = node;
  const seen = new Set();
  while (cur && !seen.has(String(cur.cateId))) {
    seen.add(String(cur.cateId));
    names.unshift(cur.cateName);
    const parentId = String(cur.parentCateId);
    if (!parentId || parentId === "0" || !byId.has(parentId)) break;
    cur = byId.get(parentId);
  }
  return names.join(" > ");
}
