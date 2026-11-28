"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;

/**
 * 市场-通用 - 获取店铺主营类目
 * GET /portal/shop/getMainCateInfo.json (sycm.taobao.com)
 *
 * 返回当前店铺的主营一级类目信息，用于自动锚定搜索排行的默认类目。
 *
 * @param {Object} options
 * @returns {Promise<{cateLevel1Id, cateLevel1Name, cateLevel, bcSeller}>}
 */
async function default_1(options) {
  const resp = await fetch('/portal/shop/getMainCateInfo.json', { credentials: 'include' });
  const body = await resp.json();
  const d = body.content?.data || body.data;
  if (!d) throw new Error(body.content?.message || 'API error');

  return {
    cateLevel1Id: d.cateLevel1Id,
    cateLevel1Name: d.cateLevel1Name,
    cateLevel: d.cateLevel,
    bcSeller: d.bcSeller,
  };
}
