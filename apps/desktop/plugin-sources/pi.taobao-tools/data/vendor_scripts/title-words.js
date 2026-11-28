/**
 * 标题拆词（kwType: se_keyword/core_keyword/prop_keyword/lgt_keyword）
 * GET /cc/item/title/v2/word/list.json (sycm.taobao.com)
 *
 * 规格来源: skills/sycm-item-data-fetch/reference/title-words.md（B 组重建，参数默认值以文档为准）
 * 
 * 返回: 原始数据透传（body.data）
 */
module.exports = async function title_words(options = {}) {
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 600)));

  // ---- 参数组装（/cc/ 族不带 token/marketVersion；可选参数显式空串）----
  const P = {
    itemId: (options.itemId !== undefined && options.itemId !== null && options.itemId !== '') ? options.itemId : (() => { throw new Error('必填参数 itemId 缺失'); })(),
    kwType: options.kwType !== undefined ? String(options.kwType) : 'se_keyword',
    dateType: options.dateType !== undefined ? String(options.dateType) : 'recent7',
    dateRange: computeRange(options.dateType || 'recent7', options.dateRange),
    device: options.device !== undefined ? String(options.device) : '0',
  };

  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(P)) qp.set(k, String(v));
  // 此族接口不带 token（带了反而 1003）
  const resp = await fetch(`/cc/item/title/v2/word/list.json?${qp}`, { credentials: 'include' });
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
