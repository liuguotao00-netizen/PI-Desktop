/**
 * 市场-搜索排行 - 搜索词排行列表
 *
 * 【移植修订】本拷贝已故意偏离 skills/sycm-market 原版参考件（原版保持不动）：
 *             1) rankType 实测有效值为 hot/soar/rise（原版文档 growth 为误写）；
 *             2) 新增 seUvEx/seUvDelta 字段映射；3) 全量词池 rn 失效时 rank 按行序推算。
 * GET /mc/mq/mkt/keyword/rank/pro.json (sycm.taobao.com)
 *
 * 获取指定类目下的搜索词排行，支持按搜索人气/增速排序、按词类型筛选、分页。
 * 页面可见指标: seIpvUvHits(搜索人气), seUvEx(搜索增速,小数×100=百分比;soar/rise 榜及全量词池返回),
 *               freeClkRate(点击率), payRate(支付转化率)
 *
 * @param {Object} options
 * @param {string} [options.cateId]               - 类目ID，不传则自动获取店铺主营类目下的默认二级类目
 * @param {string} [options.dateType='day']      - day / recent7 / recent30
 * @param {string} [options.dateRange]           - YYYY-MM-DD|YYYY-MM-DD
 * @param {string} [options.kwType='search']     - search(搜索词) / trend(趋势词) / core(核心词) / prop(修饰词)
 * @param {string} [options.rankType='hot']      - hot(搜索人气) / soar(搜索增速) / rise(搜索增量)
 *                                                注意: growth 是历史文档误写,并非有效榜单值;接口对未识别值
 *                                                会回退到未过滤全量词池(recordCount 为全量, rn 失效),此时 rank 由行序推算
 * @param {string} [options.keyWord='']          - 关键词筛选
 * @param {string} [options.orderBy='seIpvUvHits'] - 排序字段
 * @param {string} [options.order='desc']        - desc / asc
 * @param {number} [options.page=1]
 * @param {number} [options.pageSize=10]
 * @param {string} [options.device='0']          - 0=全部 1=PC 2=无线
 * @returns {Promise<{recordCount, words[]}>}
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = default_1;

async function default_1(options) {
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1200)));
  let cateId = options.cateId;

  // 未传 cateId 时自动获取：主营一级类目 → 类目树 → 第一个二级类目
  // 如果主营类目在市场树中不存在，fallback 到市场可用的第一个一级类目
  if (!cateId) {
    const mainResp = await fetch('/portal/shop/getMainCateInfo.json', { credentials: 'include' });
    const mainBody = await mainResp.json();
    const cateLevel1Id = mainBody.content?.data?.cateLevel1Id || mainBody.data?.cateLevel1Id;

    const treeResp = await fetch('/mc/common/free/getCateInfo.json?marketVersion=free', { credentials: 'include' });
    const treeBody = await treeResp.json();
    const allCates = treeBody.data || [];

    // 优先在主营类目下找二级类目
    let level2 = cateLevel1Id ? allCates.find(r => r[6] === cateLevel1Id && r[3] === 2) : null;

    // fallback: 主营类目在市场树中不存在，取市场可用的第一个一级类目下的第一个二级类目
    if (!level2) {
      const firstL1 = allCates.find(r => r[3] === 1);
      if (firstL1) {
        level2 = allCates.find(r => r[6] === firstL1[1] && r[3] === 2);
      }
    }
    if (!level2) throw new Error('无可用市场类目');
    cateId = String(level2[1]);
  }

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const dateType = options.dateType || 'day';

  // 根据 dateType 自动计算 dateRange
  let dateRange = options.dateRange;
  if (!dateRange) {
    // 凌晨 0:00~8:00 期间，T-1 数据尚未生成完毕，截止日期需从 T-1 偏移至 T-2
    const extraOffset = today.getHours() < 8 ? 1 : 0;
    const endDate = new Date(today - (1 + extraOffset) * 86400000); // T-1 或 T-2
    const endStr = endDate.toISOString().slice(0, 10);
    if (dateType === 'recent7') {
      const startDate = new Date(today - (7 + extraOffset) * 86400000);
      dateRange = `${startDate.toISOString().slice(0, 10)}|${endStr}`;
    } else if (dateType === 'recent30') {
      const startDate = new Date(today - (30 + extraOffset) * 86400000);
      dateRange = `${startDate.toISOString().slice(0, 10)}|${endStr}`;
    } else {
      dateRange = `${endStr}|${endStr}`;
    }
  }

  const params = new URLSearchParams({
    cateId,
    dateRange,
    dateType,
    device: options.device || '0',
    keyWord: options.keyWord || '',
    kwType: options.kwType || 'search',
    marketVersion: 'free',
    order: options.order || 'desc',
    orderBy: options.orderBy || 'seIpvUvHits',
    page: String(options.page || 1),
    pageSize: String(options.pageSize || 10),
    rankType: options.rankType || 'hot',
  });

  const resp = await fetch(`/mc/mq/mkt/keyword/rank/pro.json?${params}`, { credentials: 'include' });
  const body = await resp.json();
  if (body.code !== 0) throw new Error(body.message || `API error code=${body.code}`);

  const inner = body.data || {};
  const list = inner.data || [];
  // 已知榜单(hot/soar/rise)的 rn 是真实排名;其余 rankType 会落入未过滤全量词池,
  // 其中 rn 为乱值或缺失(实测嗯=241、皮卡丘=1537 这类脏值),一律改用行序推算排名
  const knownRankType = ['hot', 'soar', 'rise'].includes(String(options.rankType || 'hot'));
  const baseRank = ((Number(options.page) || 1) - 1) * (Number(options.pageSize) || 10);
  return {
    cateId,
    recordCount: inner.recordCount || 0,
    words: list.map((w, i) => ({
      searchWord: w.searchWord?.value,
      rank: knownRankType ? (w.rn?.value ?? baseRank + i + 1) : (baseRank + i + 1),
      seIpvUvHits: w.seIpvUvHits?.value,
      seIpvUvHitsCrc: w.seIpvUvHits?.cycleCrc,
      seUvEx: w.seUvEx?.value,
      seUvDelta: w.seUvDelta?.value,
      clickUv: w.clickUv?.value,
      clickThroughRate: w.clickThroughRate?.value,
      payRate: w.payRate?.value,
    })),
  };
}
