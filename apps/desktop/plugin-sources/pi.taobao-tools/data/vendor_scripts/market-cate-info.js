"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;

/**
 * 市场-通用 - 获取可用类目树
 * GET /mc/common/free/getCateInfo.json (sycm.taobao.com)
 *
 * 返回当前商家可用的完整类目树（用于搜索排行的类目选择）。
 * 每条记录格式: [parentCateId, cateId, cateName, cateFlag, marketVersion, isLeaf, cateLevel1Id, cateLevel1Name]
 *
 * @param {Object} options
 * @param {string|number} [options.cateLevel1Id] - 一级类目ID，传入后只返回该类目下的子类目
 * @returns {Promise<{categories[]}>}
 */
async function default_1(options) {
  const params = new URLSearchParams({ marketVersion: 'free' });
  const resp = await fetch(`/mc/common/free/getCateInfo.json?${params}`, { credentials: 'include' });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(body.message || `API error code=${body.code}`);

  const raw = body.data || [];
  let categories = raw.map(r => ({
    parentCateId: r[0],
    cateId: r[1],
    cateName: r[2],
    cateFlag: r[3],
    isLeaf: r[5] === 'Y',
    cateLevel1Id: r[6],
    cateLevel1Name: r[7],
  }));

  // 按一级类目过滤
  if (options.cateLevel1Id) {
    const id = Number(options.cateLevel1Id);
    categories = categories.filter(c => c.cateLevel1Id === id);
  }

  return { categories };
}
