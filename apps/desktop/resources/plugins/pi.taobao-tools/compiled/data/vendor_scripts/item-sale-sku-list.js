/**
 * 商品 SKU 销售明细
 * GET /cc/item/sale/sku/list.json (sycm.taobao.com)
 *
 * 规格来源: skills/sycm-item-data-fetch/reference/item-sale-sku-list.md（B 组重建，参数默认值以文档为准）
 * 实测: dateType=today 返回 20001 业务异常，默认改 recent7；indexCode 缺省报错，必须显式传
 * 返回: 原始数据透传（body.data）
 */
module.exports = async function item_sale_sku_list(options = {}) {
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 600)));

  // ---- 参数组装（/cc/ 族不带 token/marketVersion；可选参数显式空串）----
  const P = {
    itemId: (options.itemId !== undefined && options.itemId !== null && options.itemId !== '') ? options.itemId : (() => { throw new Error('必填参数 itemId 缺失'); })(),
    dateType: options.dateType !== undefined ? String(options.dateType) : 'recent7',
    dateRange: computeRange(options.dateType || 'recent7', options.dateRange),
    orderBy: options.orderBy !== undefined ? String(options.orderBy) : 'cartCnt',
    order: options.order !== undefined ? String(options.order) : 'desc',
    page: options.page !== undefined ? options.page : 1,
    pageSize: options.pageSize !== undefined ? options.pageSize : 10,
    device: options.device !== undefined ? String(options.device) : '0',
    indexCode: options.indexCode !== undefined ? String(options.indexCode) : 'cartCnt,payAmt,payItmCnt,payByrCnt,currentStockCnt,stockDays,sellRate',
  };

  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(P)) qp.set(k, String(v));
  // 此族接口不带 token（带了反而 1003）
  const resp = await fetch(`/cc/item/sale/sku/list.json?${qp}`, { credentials: 'include' });
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
