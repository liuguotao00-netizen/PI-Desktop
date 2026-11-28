/**
 * 全店洞察 - 叶子类目列表（分页 / pagination）
 * 来源: dmp-taobao / shop-cate-list
 * GET https://dmp.advgateway.taobao.com/api/goods/cate/list
 *
 * 资源与性能约束：
 * - 分页参数：page >= 1，pageSize 即 batch_size / limit，范围 [1, 100]，默认 10。
 * - max_items：单次调用不超过 pageSize，避免一次性 stream 大量数据；
 *   跨页汇总由 Agent 侧按 pager.total 分页调用，每次 chunk_size = pageSize。
 */
module.exports = async function shopCateList(params = {}) {
  async function getAuth() {
    const startedAt = Date.now()
    while (true) {
      const token = (
        document.cookie.split(/\s*;\s*/)
          .find(value => value.startsWith('_tb_token_='))
        || ''
      ).slice(11)
      let Magix = window.Magix
      try {
        if (!Magix?.config && window.seajs?.cache) {
          for (const item of Object.values(window.seajs.cache)) {
            const candidate = item?.exports?.default || item?.exports
            if (candidate?.config) {
              Magix = candidate
              break
            }
          }
        }
      } catch (_) {}
      const user =
        Magix?.config?.('dmp-new.user')
        || Magix?.config?.('mx.user')
        || {}
      const csrfId = user.csrfId || user.accessInfo?.csrfId || ''
      if (token && csrfId) {
        return { bizCode: 'dmp', _tb_token_: token, _csrf: csrfId, csrfId }
      }
      if (Date.now() - startedAt >= 20000) {
        if (!token) throw new Error('缺少 _tb_token_ Cookie，请先登录达摩盘')
        throw new Error('等待达摩盘 csrfId 超时')
      }
      await new Promise(resolve => window.setTimeout(resolve, 250))
    }
  }

  try {
    // 参数校验：required 项缺失/为空/未提供时直接返回错误，禁止使用默认值绕过
    if (!params.endDate) {
      return { ok: false, error: '必填参数 endDate 缺失或为空（required, missing）' }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.endDate || '')) {
      return { ok: false, error: 'endDate 未按 YYYY-MM-DD 格式提供' }
    }
    const period = String(params.period || '30')
    const page = Number(params.page || 1)
    const pageSize = Number(params.pageSize || 10)
    if (!['1', '7', '30'].includes(period)) {
      return { ok: false, error: 'period 未提供合法值，仅允许 1/7/30' }
    }
    if (!Number.isInteger(page) || page < 1) {
      return { ok: false, error: 'page 必填且必须是正整数' }
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return { ok: false, error: 'pageSize 必填且范围为 1–100' }
    }
    const queryParams = {
      ...(await getAuth()),
      endDate: params.endDate,
      period,
      page: String(page),
      pageSize: String(pageSize)
    }
    if (params.orderIndicator) queryParams.orderIndicator = params.orderIndicator
    if (params.orderType) queryParams.orderType = params.orderType
    const query = new URLSearchParams(queryParams)
    const response = await fetch(
      `https://dmp.advgateway.taobao.com/api/goods/cate/list?${query}`,
      { credentials: 'include' }
    )
    // 限流处理：命中 HTTP 429 时不自动 retry，交由 Agent 侧按 SLA 段落退避重试
    if (response.status === 429) {
      return { ok: false, error: 'HTTP 429 rate limit（限流），请按退避策略稍后重试' }
    }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const result = await response.json()
    if (result.info?.ok !== true) {
      return {
        ok: false,
        error: result.info?.message || result.info?.msg || '查询叶子类目失败'
      }
    }
    return {
      ok: true,
      pager: result.data?.pager || {},
      categories: result.data?.list || []
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}
