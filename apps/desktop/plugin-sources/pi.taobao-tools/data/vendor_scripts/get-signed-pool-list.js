/**
 * 获取已签约活动池列表
 *
 * 采集模板来源: api-425 GET /priceTrusteeship/signedPoolList.do
 */
module.exports = async function getSignedPoolList() {
  const BASE_URL = (typeof process !== 'undefined' && process.env && process.env.SALE_API_BASE) || 'https://sale.taobao.com';
  const tbToken = window._tb_token_ || document.cookie.split(';').map(c => c.trim().split('=')).find(c => c[0] === '_tb_token_')?.[1];
  if (!tbToken) throw new Error('未获取到登录凭证，请确认已登录千牛并有权限访问自动跟价页面');

  const request = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(`${BASE_URL}/priceTrusteeship/signedPoolList.do?_tb_token_=${tbToken}`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });
      if (resp.status === 429) throw new Error('接口限流，请稍后重试');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const res = await resp.json();
      if (!res.success) throw new Error(res.message || res.structErrorMessage || '请求失败');
      return { ok: true, data: res.data };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await request();
  } catch (error) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return request();
  }
};
