/**
 * 商品排行页标准类目检索（拉全树 + 前端过滤，复刻页面逻辑）
 * GET /cc/common/category/getStdCate.json (sycm.taobao.com)
 *
 * 规格来源: skills/sycm-item-data-fetch/reference/item-category-search.md（B 组重建，参数默认值以文档为准）
 * 入参: keyword(必填)/limit(默认50)/onlyLeaf(默认false)/cateLevel(可选过滤)
 * 返回: 过滤后的类目列表
 */
module.exports = async function item_category_search(options = {}) {
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 600)));

  // ---- 参数组装（/cc/ 族不带 token/marketVersion；可选参数显式空串）----
  const P = {

  };

  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(P)) qp.set(k, String(v));
  // 此族接口不带 token（带了反而 1003）
  const resp = await fetch(`/cc/common/category/getStdCate.json?${qp}`, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.json();
  if (body.code !== 0) throw new Error(body.msg || `API error code=${body.code}`);
  // 复刻页面逻辑：先拉全树，再前端按关键词过滤
  const raw = body.data || [];
  const kw = String(options.keyword ?? options.query ?? '').trim().toLowerCase();
  const limit = Number(options.limit) || 50;
  const onlyLeaf = options.onlyLeaf ?? false;
  const cateLevel = options.cateLevel !== undefined ? String(options.cateLevel) : '';
  const all = raw.map(r => ({
    parentCateId: r[0], cateId: r[1], cateName: r[2], cateFlag: r[3],
    isLeaf: r[5] === 'Y', cateLevel1Id: r[6], cateLevel1Name: r[7],
  }));
  let hit = all.filter(c =>
    (!kw || (c.cateName || '').toLowerCase().includes(kw))
    && (!onlyLeaf || c.isLeaf)
    && (!cateLevel || String(c.cateFlag) === cateLevel));
  const total = hit.length;
  if (limit > 0) hit = hit.slice(0, limit);
  return { keyword: kw, total, rawCount: raw.length, categories: hit };
};

function computeRange(dateType, explicit) {
  if (explicit) return explicit;
  const now = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (dateType === 'today') return fmt(now) + '|' + fmt(now);
  if (dateType === 'yesterday') {
    const y = new Date(now - 86400000);
    return fmt(y) + '|' + fmt(y);
  }
  const days = { day: 1, recent7: 7, recent30: 30 }[dateType] || 1;
  const end = new Date(now - 86400000);
  const start = new Date(now - days * 86400000);
  return fmt(start) + '|' + fmt(end);
}
