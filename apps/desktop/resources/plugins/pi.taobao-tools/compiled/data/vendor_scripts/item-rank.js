/**
 * 商品排行列表（主入口：获取 itemId）
 * GET /cc/item/view/top.json (sycm.taobao.com)
 *
 * 真机结论（2026-10-10 逆向验证）：
 * - /cc/ 族接口**不带 token、不带 marketVersion**（带了反而 1003），可选参数显式传空串
 * - dateRange 窗口长度必须与 dateType 严格等长（否则 1003）；
 *   任意平移的 7/30 天窗口均有效（如 2026-10-04|2026-10-10）
 * - 文档里的 compareRange/long 端点实测不被接受——自定义区间按长度映射 recent7/recent30
 * - /cc/ 模块日期用 T-1 结尾（无 /mc/ 市场模块的凌晨 8 点偏移）；本地时间格式化（勿用 toISOString）
 * - pageSize 上限 20；推广数据自动融合（DMP 接口，失败不阻断）
 *
 * 响应直接透出原始 API 数据（不做字段加工），字段结构见 reference/item-rank.md。
 */
module.exports = async function itemRank(options = {}) {
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 800)));

  let dateType = options.dateType || 'day';
  let dateRange = options.dateRange || '';
  if (dateType === 'today') {
    throw new Error('dateType=today 请使用 item-rank-live.js（实时接口）');
  }
  function rangeDays(rg) {
    const [s, e] = rg.split('|');
    return Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
  }
  function fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const daysOfType = { day: 1, recent7: 7, recent30: 30 };

  // compareRange（文档口径）→ 按区间长度映射 recent7/recent30（等长窗口任意平移均有效）
  if (dateType === 'compareRange') {
    if (!dateRange) throw new Error('dateType=compareRange 需要 dateRange（YYYY-MM-DD|YYYY-MM-DD）');
    const days = rangeDays(dateRange);
    if (days === 7) dateType = 'recent7';
    else if (days === 30) dateType = 'recent30';
    else throw new Error(`自定义区间 ${dateRange} 为 ${days} 天；本接口仅支持 7/30 天窗口`);
  }
  if (!daysOfType[dateType]) throw new Error(`dateType 非法: ${dateType}`);
  if (dateRange && rangeDays(dateRange) !== daysOfType[dateType]) {
    throw new Error(`dateRange(${dateRange}) 长度与 dateType=${dateType} 不匹配（会导致 1003）`);
  }
  if (!dateRange) {
    const now = new Date();
    const end = new Date(now - 86400000);            // T-1
    const start = new Date(now - daysOfType[dateType] * 86400000);
    dateRange = `${fmt(start)}|${fmt(end)}`;
  }

  const path = '/cc/item/view/top.json';

  async function fetchRankPage(page) {
    const qp = new URLSearchParams({
      dateRange,
      dateType,
      pageSize: String(Math.min(Number(options.pageSize) || 10, 20)),
      page: String(page),
      order: options.order || 'desc',
      orderBy: options.orderBy || 'payAmt',
      device: options.device || '0',
      compareType: options.compareType || 'cycle',
      keyword: options.keyword || '',
      follow: String(options.follow ?? false),
      cateId: options.cateId || '',
      cateLevel: options.cateLevel || '',
      indexCode: options.indexCode || '',
    });
    const resp = await fetch(`${path}?${qp}`, { credentials: 'include',
      signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    if (body.code !== 0) throw new Error(body.msg || `API error code=${body.code}`);
    return body.data || {};
  }

  const data = await fetchRankPage(Number(options.page) || 1);
  const items = Array.isArray(data.data) ? data.data : [];

  // DMP 推广数据融合（失败不阻断）
  try {
    const qp2 = new URLSearchParams({
      dateRange, dateType,
      pageSize: String(Math.min(Number(options.pageSize) || 10, 20)),
      page: String(Number(options.page) || 1),
      indexCode: 'fCharge,pDROI',
    });
    const r2 = await fetch('/cc/item/view/dmp/newproduct/top.json?' + qp2,
      { credentials: 'include', signal: AbortSignal.timeout(10000) });
    const j2 = await r2.json();
    if (j2.code === 0 && Array.isArray(j2.data?.data)) {
      const byId = new Map();
      for (const row of j2.data.data) {
        const id = row?.itemId?.value ?? row?.itemId;
        if (id) byId.set(String(id), row);
      }
      for (const it of items) {
        const id = it?.itemId?.value ?? it?.itemId;
        const hit = byId.get(String(id));
        it.fCharge = hit?.fCharge ?? {};
        it.pDROI = hit?.pDROI ?? {};
      }
    }
  } catch (_) { /* 推广数据失败不阻断 */ }

  return {
    updateTime: data.updateTime ?? null,
    totalCount: data.recordCount ?? data.totalCount ?? null,
    totalPages: data.totalPages ?? null,
    page: Number(options.page) || 1,
    pageSize: Math.min(Number(options.pageSize) || 10, 20),
    items,
  };
};
