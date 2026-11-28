// @docs README.md#内部调用
// 首页数据概览。端点及版本参数来自 sycm/home/collectors/special-reads.ts。
// 直接取 overview，保留全部原始指标及比较字段，不使用趋势末点代替汇总。
module.exports = async function shopCoreOverview(options = {}) {
  const allowed = ['dateType', 'dateRange'];
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new Error(`不支持参数 ${key}`);
  }
  const dateType = options.dateType === undefined ? 'day' : options.dateType;
  if (!['today', 'yesterday', 'day', 'week', 'month', 'recent7', 'recent30', 'compareRange'].includes(dateType)) {
    throw new Error('dateType 必须为 today/yesterday/day/week/month/recent7/recent30/compareRange');
  }
  // 生意参谋按中国自然日统计，不能随运行机器的时区改变“昨日”。
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = name => parts.find(p => p.type === name).value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const dayMs = 86400000;
  const parseDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('dateRange 日期必须为 YYYY-MM-DD');
    const ms = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('dateRange 含无效日期');
    return ms;
  };
  const format = ms => new Date(ms).toISOString().slice(0, 10);
  const todayMs = parseDate(today);
  let start, end;
  if (options.dateRange !== undefined) {
    if (typeof options.dateRange !== 'string' || options.dateRange.split('|').length !== 2) {
      throw new Error('dateRange 必须为 YYYY-MM-DD|YYYY-MM-DD');
    }
    [start, end] = options.dateRange.split('|').map(parseDate);
  } else if (dateType === 'compareRange') {
    throw new Error('dateType=compareRange 时必须传 dateRange');
  } else if (dateType === 'today') {
    start = end = todayMs;
  } else if (dateType === 'week') {
    const monday = todayMs - ((new Date(todayMs).getUTCDay() + 6) % 7) * dayMs;
    start = monday - 7 * dayMs;
    end = monday - dayMs;
  } else if (dateType === 'month') {
    const first = new Date(todayMs);
    first.setUTCDate(1);
    end = first.getTime() - dayMs;
    first.setUTCMonth(first.getUTCMonth() - 1);
    start = first.getTime();
  } else {
    end = todayMs - dayMs;
    start = end - (({ recent7: 7, recent30: 30 }[dateType] || 1) - 1) * dayMs;
  }
  if (start > end) throw new Error('dateRange 开始日期不能晚于结束日期');
  if (dateType === 'today') {
    if (start !== todayMs || end !== todayMs) throw new Error('today 只能查询当日实时数据');
  } else {
    if (end >= todayMs) throw new Error('历史 dateRange 必须截至昨日或更早；今日使用 today');
    const days = (end - start) / dayMs + 1;
    if (dateType === 'compareRange' && days > 31) throw new Error('自定义周期单次最多31天（含首尾），请按不重叠的最多31天范围分批串行调用');
    if (['day', 'yesterday'].includes(dateType) && days !== 1) throw new Error('day/yesterday 的 dateRange 必须为同一天');
    if (dateType === 'yesterday' && end !== todayMs - dayMs) throw new Error('yesterday 的 dateRange 必须为昨日');
    if ((dateType === 'recent7' && days !== 7) || (dateType === 'recent30' && days !== 30)) throw new Error('dateRange 天数与 dateType 不一致');
    if (dateType === 'week' && (days !== 7 || new Date(start).getUTCDay() !== 1)) throw new Error('week 的 dateRange 必须为完整自然周（周一到周日）');
    if (dateType === 'month' && (new Date(start).getUTCDate() !== 1 || new Date(end + dayMs).getUTCDate() !== 1 || format(start).slice(0, 7) !== format(end).slice(0, 7))) {
      throw new Error('month 的 dateRange 必须为完整自然月');
    }
  }
  const dateRange = `${format(start)}|${format(end)}`;
  // 首页的滚动窗口走源码已有的自定义范围端点，不把商品模块 recent7/30 塞给首页接口。
  const requestDateType = ['recent7', 'recent30'].includes(dateType) ? 'compareRange' : dateType === 'yesterday' ? 'day' : dateType;
  const requestDateRange = requestDateType === 'compareRange'
    ? `${dateRange},${format(start - (end - start + dayMs))}|${format(start - dayMs)}`
    : dateRange;

  // 等页面自然加载出已知首页卡片，不点击日期控件，也不猜版本或失败后换端点重试。
  let pageVersion;
  for (let attempt = 0; attempt < 51; attempt++) {
    if (document.querySelector('[oui-card-uid="pc新首页-v51|数据概览"]')) pageVersion = 'newv51';
    else if (document.querySelector('[oui-card-uid="pc新首页-v6|数据概览-v3"]')) pageVersion = 'newv6';
    if (pageVersion) break;
    if (attempt < 50) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!pageVersion) throw new Error('HOME_NOT_READY: 未识别首页数据概览，请确认首页加载及访问权限');
  const version = pageVersion === 'newv51' ? 'v2' : 'v3';
  let endpoint;
  const params = new URLSearchParams();
  if (requestDateType === 'today') {
    endpoint = `/portal/live/new/index/overview${pageVersion === 'newv51' ? '' : '/v3'}.json`;
    params.set('dateType', 'today');
  } else {
    endpoint = requestDateType === 'compareRange'
      ? `/portal/long/period/nodistinct/coreIndex/getShopMainIndexes/${version}.json`
      : `/portal/coreIndex/new/overview/${version}.json`;
    params.set('dateRange', requestDateRange);
    params.set('dateType', requestDateType);
    if (requestDateType === 'compareRange') params.set('device', '0');
    if (requestDateType === 'compareRange' || requestDateType === 'month' || pageVersion === 'newv6') params.set('needCycleCrc', 'true');
    else params.set('device', '2');
  }
  const response = await fetch(`${endpoint}?${params}`, { credentials: 'include', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  // 宿主 CDP 实页确认：首页接口使用 {hasError, content:{code,data,message}}，
  // 与商品 /cc/ 接口的顶层 code/data 不同；不能把正常首页响应判成异常。
  const content = body?.content;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.hasError !== 'boolean'
    || !content || typeof content !== 'object' || Array.isArray(content) || typeof content.code !== 'number') {
    throw new Error('首页概览响应结构异常');
  }
  if (body.hasError || content.code !== 0) throw new Error(content.message || `API error code=${content.code}`);
  // 无数据对象与读取/解码失败分开；不把缺失、字符串密文或 null 伪装成零值。
  if (!content.data || typeof content.data !== 'object' || Array.isArray(content.data)) throw new Error('首页概览数据结构异常，未取得可读取的指标对象');
  // 历史普通周期含 self/rivalAvg/rivalGood，自定义为平铺指标，实时为 data.today/yestday。
  // 保留接口实际结构，不将自定义再包进 self 或把原始 statDate 当成请求日期。
  return { ok: true, dateType, dateRange, requestDateType, requestDateRange, pageVersion, data: content.data };
};
