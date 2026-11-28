/**
 * 商品价格信息（类目/价格带归属）
 * GET /cc/item/price/info.json (sycm.taobao.com)
 *
 * 规格来源: skills/sycm-item-data-fetch/reference/item-price-info.md（B 组重建，参数默认值以文档为准）
 * 
 * 返回: 原始数据透传（body.data）
 */
module.exports = async function item_price_info(options = {}) {
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 600)));

  // ---- 参数组装（/cc/ 族不带 token/marketVersion；可选参数显式空串）----
  const P = {
    itemId: (options.itemId !== undefined && options.itemId !== null && options.itemId !== '') ? options.itemId : (() => { throw new Error('必填参数 itemId 缺失'); })(),
  };

  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(P)) qp.set(k, String(v));
  // 此族接口不带 token（带了反而 1003）
  const resp = await fetch(`/cc/item/price/info.json?${qp}`, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.json();
  if (body.code !== 0) throw new Error(body.msg || `API error code=${body.code}`);
  return body.data ?? body;
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
