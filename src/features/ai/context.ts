import type { AnalysisSnapshot, PublicMarketSection } from './types';
import type { ContextDependencies } from './dependencies';
import type { PriceBar } from '../../shared/types';
import { calculate, movingAverage } from '../../shared/indicators';
import { ChartProvider } from '../charts/data';
import { AiQuoteProvider } from './quote-data';
import { AnalysisEnvironment } from './environment';
import { pick, attempt, abortError } from './data';
import { SYSTEM } from './prompt';
const BENCHMARKS = ['sh000001', 'sz399001', 'sz399006', 'sh000300'];
const QUOTE_KEYS = [
  'symbol',
  'name',
  'price',
  'previousClose',
  'delta',
  'percent',
  'date',
  'timestamp',
  'high',
  'low',
  'turnoverRate'
];
function last(values: Array<number | null>): number | null {
  const n = values.at(-1);
  return Number.isFinite(n) ? Number(n!.toFixed(5)) : null;
}
function technical(bars: PriceBar[]) {
  const result: Record<string, number | null | Record<string, number | null>> = {};
  for (const period of [5, 10, 20, 60]) result['MA' + period] = last(movingAverage(bars, period));
  for (const type of ['macd', 'kdj', 'rsi'] as const) {
    const series = calculate(bars, type)!,
      value: Record<string, number | null> = {};
    for (const line of series.lines) value[line.name] = last(line.values);
    if (series.histogram) value.histogram = last(series.histogram);
    result[type] = value;
  }
  return result;
}
class AnalysisContext {
  declare now: () => Date;
  declare quoteProvider: AiQuoteProvider;
  declare chartProvider: ChartProvider;
  declare environment: AnalysisEnvironment;
  declare stocks: ContextDependencies['stocks'];

  constructor({
    stocks,
    market,
    globals,
    commodities,
    news,
    chartProvider = new ChartProvider(),
    quoteProvider = new AiQuoteProvider(),
    now = () => new Date(),
    environment = new AnalysisEnvironment({ market, globals, commodities, news, now })
  }: ContextDependencies) {
    Object.assign(this, { stocks, market, chartProvider, quoteProvider, now, environment });
  }
  async collect(target: string, signal?: AbortSignal): Promise<AnalysisSnapshot> {
    const symbol = target === 'market' ? 'sh000001' : target;
    if (!/^(?:sh|sz|bj)\d{6}$/.test(symbol)) throw new Error('当前 AI 分析支持 A 股、场内 ETF 和沪深指数。');
    const data: AnalysisSnapshot = {
      target: target === 'market' ? '沪深大盘（以上证指数日K为技术参考）' : symbol,
      capturedAt: this.now().toISOString(),
      timeZone: 'Asia/Shanghai',
      notes: []
    };
    const [quoteResult, chartResult, background] = await Promise.all([
      attempt((s) => this.quoteProvider.load([...new Set([symbol, ...BENCHMARKS])], s), signal, 18000),
      attempt((s) => this.chartProvider.load(symbol, 'daily', s), signal, 18000),
      attempt((s) => this.environment.load(symbol, s, this.stocks?.quotes.get(symbol)?.name), signal, 20000)
    ]);
    if (signal?.aborted) throw abortError();
    const live = quoteResult.ok && quoteResult.value.quotes.get(symbol);
    const cached = this.stocks?.quotes.get(symbol);
    const quote = live || cached;
    if (quote) data.quote = { ...pick(quote, QUOTE_KEYS), source: quote.source || '腾讯行情', cached: !live };
    if (!live) data.notes.push(quote ? '最新报价获取失败，报价使用缓存，需核对报价时间。' : '最新报价不可用。');
    if (chartResult.ok && chartResult.value.bars?.length) {
      const chart = chartResult.value;
      const bars = chart.bars.filter((b) =>
        ['open', 'close', 'high', 'low', 'volume'].every((k) => Number.isFinite(b[k]))
      );
      if (bars.length)
        data.daily = {
          ...pick(chart, ['source', 'date', 'adjustment', 'timestamp', 'turnoverRate', 'turnoverTimestamp']),
          volumeUnit: '手',
          indicators: technical(bars),
          bars: bars
            .slice(-60)
            .map((b) => pick(b, ['time', 'open', 'high', 'low', 'close', 'volume', 'amount', 'turnoverRate']))
        };
    }
    if (!data.daily) data.notes.push('日K和技术指标不可用，不推断技术形态。');
    if (background.ok) {
      const env = background.value;
      for (const key of ['market', 'sectors', 'globalMarkets', 'commodities', 'news'])
        if (env[key]) data[key] = env[key];
      data.notes.push(...(env.notes || []));
    } else data.notes.push('外围上下文获取失败，无法完整评估大盘、板块及全球环境。');
    const benchmarks: PublicMarketSection[] = BENCHMARKS.map((id) => {
      const fresh = quoteResult.ok && quoteResult.value.quotes.get(id),
        q = fresh || this.stocks?.quotes.get(id);
      return q
        ? { ...pick(q, QUOTE_KEYS), source: q.source || '腾讯行情', cached: !fresh }
        : { symbol: id, missing: true };
    });
    data.market = { ...(data.market || { turnoverMissing: true }), benchmarks };
    // Comparable timestamps only; a stale industry quote must not produce a
    // seemingly precise relative-strength number against today's stock price.
    const quoteEpoch = (value) => {
      if (!/^\d{14}$/.test(value || '')) return NaN;
      return Date.parse(value.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00'));
    };
    const epoch = quoteEpoch(data.quote?.timestamp);
    data.relativeStrength = {
      unit: '百分点',
      comparisons: [],
      note: '只比较相差不超过15分钟且处于同一北京时间日期的报价；不代表超额收益或因果关系。'
    };
    const compare = (name, percent, time) => {
      const sameDate =
        Number.isFinite(epoch) &&
        Number.isFinite(time) &&
        new Date(epoch + 8 * 3600000).toISOString().slice(0, 10) ===
          new Date(time + 8 * 3600000).toISOString().slice(0, 10);
      if (
        sameDate &&
        Math.abs(epoch - time) <= 15 * 60000 &&
        Number.isFinite(data.quote?.percent) &&
        Number.isFinite(percent)
      )
        data.relativeStrength!.comparisons.push({
          name,
          difference: Number((data.quote!.percent - percent).toFixed(2))
        });
    };
    for (const q of benchmarks) if (!q.missing) compare(q.name || q.symbol, q.percent, quoteEpoch(q.timestamp));
    const industry = data.sectors?.rows?.find((r) => r.name === data.sectors?.industry);
    if (industry) compare(industry.name, industry.percent, industry.timestamp * 1000);
    if (
      !data.quote &&
      !data.daily &&
      !(target === 'market' && (data.market.amount !== undefined || benchmarks.some((q) => !q.missing)))
    )
      throw new Error('暂无可用行情（该标的），未调用 AI。请稍后重新分析。');
    data.coverage = [
      { label: '个股 / 指数', detail: data.quote || data.daily ? '已获取' : '缺失' },
      {
        label: '大盘',
        detail: `${benchmarks.filter((q) => !q.missing).length}/${BENCHMARKS.length} 指数${data.market.amount !== undefined ? '，含成交额' : '，成交额缺失'}`
      },
      {
        label: '所属板块',
        detail:
          data.sectors?.applicable === false
            ? 'ETF / 指数不适用'
            : `${data.sectors?.rows?.length || 0} 个${data.sectors?.quoteFailure ? '（行情不完整）' : ''}${data.sectors?.cached ? '（缓存）' : ''}`
      },
      {
        label: '全球',
        detail: `${data.globalMarkets?.quotes?.length || 0}/${data.globalMarkets?.requested || 10} 指数`
      },
      { label: '商品', detail: `${data.commodities?.quotes?.length || 0}/4` },
      { label: '快讯', detail: `${data.news?.items?.length || 0} 条` }
    ];
    data.notes.push(
      '以上为采集时的行情快照；报价日期或日K日期早于今天时，不代表今天实时走势。追问沿用此快照，重新分析才更新数据。'
    );
    return data;
  }
}
export { AnalysisContext, SYSTEM, technical, pick, BENCHMARKS };
