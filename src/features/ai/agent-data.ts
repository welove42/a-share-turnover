import { AnalysisContext } from './context';
import { attempt, abortError, pick } from './data';
import { summarizeChart, summarizeIntraday, dayOf, type Period } from './technical-context';
import { isEtfCandidate } from '../funds/etf-quote';
import type { AnalysisSnapshot, ToolDefinition } from './types';
import { stockSession } from '../turnover/market';

const names = {
  get_quote: '最新个股/指数报价',
  get_technical: '分时或日周月技术数据',
  get_market: '大盘与同刻量能',
  get_environment: '所属板块或全球环境',
  get_etf: 'ETF折溢价',
  get_news: '相关公开快讯'
};
export type QueryName = keyof typeof names;
const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties, additionalProperties: false });
const symbol = { type: 'string', description: 'sh/sz/bj加六位代码；省略用当前标的' };
export const TOOLS: ToolDefinition[] = Object.entries(names).map(([name, description]) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: schema({
      symbol,
      ...(name === 'get_technical'
        ? {
            period: { type: 'string', enum: ['intraday', 'intraday5', 'daily', 'weekly', 'monthly'] },
            bars: { type: 'integer', minimum: 0, maximum: 30, description: '需要原始K线时填1至30，默认仅指标摘要' }
          }
        : {}),
      ...(name === 'get_environment' ? { scope: { type: 'string', enum: ['sector', 'global'] } } : {}),
      ...(name === 'get_news'
        ? { query: { type: 'string', maxLength: 80, description: '可选关键词，检索已接入快讯，非全网搜索' } }
        : {})
    })
  }
}));

/** 仅显式解释/续写跳过刷新；模糊追问保守地检查最新行情，不把旧结论当现状。 */
export function explanationOnly(question?: string): boolean {
  if (!question || /现在|目前|最新|今天|今日|刚才.*(?:涨|跌)|还能|有没有变化|实时/.test(question)) return false;
  return (
    /^(?:继续[。！!]?|接着说|展开(?:说|解释).*)$/.test(question.trim()) ||
    /什么意思|是什么(?:意思)?|怎么理解|解释一下|为什么(?:周线|日线|月线).*不同/.test(question)
  );
}

export interface QueryData {
  prepare(
    target: string,
    previous: AnalysisSnapshot | null,
    question: string | undefined,
    signal: AbortSignal
  ): Promise<AnalysisSnapshot>;
  execute(name: string, args: unknown, target: string, signal: AbortSignal): Promise<unknown>;
}

/** 工具只能读取已接入的数据源，参数不能提供任意 URL、文件路径或凭据。 */
export class AgentData implements QueryData {
  private cache = new Map<string, { at: number; value: any }>();
  constructor(
    private source: AnalysisContext,
    private now = () => Date.now()
  ) {}

  private async cached(key: string, ttl: number, signal: AbortSignal, read: (signal: AbortSignal) => Promise<any>) {
    if (signal.aborted) throw abortError();
    const time = this.now(),
      old = this.cache.get(key);
    if (old && time >= old.at && time - old.at < ttl) return { ...old.value, cached: true };
    const result = await attempt(read, signal, 20000);
    if (signal.aborted) throw abortError();
    if (result.ok) {
      const value = { ...result.value, fetchedAt: new Date(time).toISOString() };
      if (this.cache.size >= 60) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: time, value });
      return value;
    }
    if (old && time >= old.at && time - old.at < 7 * 86400000)
      return {
        ...old.value,
        cached: true,
        fetchFailed: true,
        error: '本次查询失败，以下为原时间数据，不能当作最新行情。'
      };
    return {
      missing: true,
      fetchFailed: true,
      error: '本次数据查询失败，不能推断缺失值。',
      fetchedAt: new Date(time).toISOString()
    };
  }

  async execute(name: string, raw: unknown, target: string, signal: AbortSignal): Promise<any> {
    if (!Object.hasOwn(names, name)) throw new Error('不支持的查询工具');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('查询参数必须为对象');
    const args = raw as Record<string, any>;
    const allowed = new Set([
      'symbol',
      ...(name === 'get_technical' ? ['period', 'bars'] : []),
      ...(name === 'get_environment' ? ['scope'] : []),
      ...(name === 'get_news' ? ['query'] : [])
    ]);
    if (Object.keys(args).some((k) => !allowed.has(k))) throw new Error('存在不支持的查询参数');
    const code = args.symbol ?? (target === 'market' ? 'sh000001' : target);
    if (typeof code !== 'string' || !/^(sh|sz|bj)\d{6}$/.test(code))
      throw new Error('仅支持A股、场内ETF及沪深指数代码');
    const period = args.period ?? 'daily',
      bars = args.bars ?? 0,
      scope = args.scope ?? 'sector';
    if (
      name === 'get_technical' &&
      (!['intraday', 'intraday5', 'daily', 'weekly', 'monthly'].includes(period) ||
        !Number.isInteger(bars) ||
        bars < 0 ||
        bars > 30)
    )
      throw new Error('图表周期或K线数量无效');
    if (name === 'get_environment' && !['sector', 'global'].includes(scope)) throw new Error('环境查询范围无效');
    if (name === 'get_news' && args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 80))
      throw new Error('新闻关键词过长');
    const session = stockSession(new Date(this.now()));
    const ttl = ['get_quote', 'get_etf', 'get_market', 'get_technical'].includes(name)
      ? session.polling
        ? 20000
        : 120000
      : 120000;
    const key = JSON.stringify([
      name,
      code,
      period,
      bars,
      scope,
      args.query || '',
      session.phase,
      dayOf(new Date(this.now()))
    ]);
    return this.cached(key, ttl, signal, async (querySignal) => {
      const now = new Date(this.now());
      if (name === 'get_quote' || name === 'get_etf') {
        if (name === 'get_etf' && !isEtfCandidate(code))
          return { applicable: false, reason: '当前代码不是支持的场内ETF' };
        const local = this.source.stocks?.quotes.get(code);
        const localTime = /^\d{14}$/.test(local?.timestamp || '')
          ? Date.parse(
              local!.timestamp.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00')
            )
          : NaN;
        const localFresh = Number.isFinite(localTime) && this.now() >= localTime && this.now() - localTime < 20000;
        const q = localFresh ? local : (await this.source.quoteProvider.load([code], querySignal)).quotes.get(code);
        if (!q) throw new Error('报价缺失');
        if (name === 'get_etf')
          return {
            symbol: code,
            source: q.source || '腾讯行情',
            quoteTimestamp: q.timestamp,
            etf: q.etf || { missing: true, reason: '行情源未提供有效IOPV，不估算溢价率。' }
          };
        return {
          ...pick(q, [
            'symbol',
            'name',
            'price',
            'percent',
            'delta',
            'previousClose',
            'high',
            'low',
            'turnoverRate',
            'date',
            'timestamp'
          ]),
          source: q.source || '腾讯行情',
          marketPhase: session.phase,
          historical: q.date !== dayOf(now),
          timing: 'timestamp为实际报价时间；获取时间不代表逐笔行情时间，休市使用最近报价。'
        };
      }
      if (name === 'get_technical') {
        const chart = await this.source.chartProvider.load(code, period, querySignal);
        const summary = period.startsWith('intraday')
          ? summarizeIntraday(chart, now)
          : summarizeChart(chart, period as Period, now);
        if (!summary) throw new Error('图表数据不完整');
        return {
          symbol: code,
          period,
          summary,
          ...(bars
            ? { bars: chart.bars.slice(-bars).map((b) => pick(b, ['time', 'open', 'high', 'low', 'close', 'volume'])) }
            : {})
        };
      }
      const sections =
        name === 'get_market'
          ? ['market']
          : name === 'get_news'
            ? ['news']
            : scope === 'global'
              ? ['global', 'commodities']
              : ['sectors'];
      const env = await this.source.environment.load(
        code,
        querySignal,
        args.query || this.source.stocks?.quotes.get(code)?.name,
        sections
      );
      if (name === 'get_market') return { market: env.market || { missing: true } };
      if (name === 'get_news') {
        const items = env.news?.items || [],
          query = args.query?.trim().toLowerCase();
        return {
          news: {
            ...env.news,
            items: (query ? items.filter((i) => JSON.stringify(i).toLowerCase().includes(query)) : items).slice(0, 5)
          }
        };
      }
      return scope === 'global'
        ? { globalMarkets: env.globalMarkets, commodities: env.commodities }
        : { sectors: env.sectors };
    });
  }

  async prepare(target: string, previous: AnalysisSnapshot | null, question: string | undefined, signal: AbortSignal) {
    if (!question || !previous) return this.source.collect(target, signal);
    if (explanationOnly(question)) return previous;
    const [quote, market, minute] = await Promise.all([
      this.execute('get_quote', {}, target, signal),
      this.execute('get_market', {}, target, signal),
      this.execute('get_technical', { period: 'intraday' }, target, signal)
    ]);
    // 各区块保留自己的时间；更新报价不能让旧日/周/月线看起来也刚更新。
    return {
      ...previous,
      capturedAt: new Date(this.now()).toISOString(),
      quote,
      market: market.market || { missing: true },
      relativeStrength: undefined,
      timeframes: {
        ...Object.fromEntries(
          Object.entries(previous.timeframes || {}).map(([period, values]) => [
            period,
            { ...values, fetchedAt: values?.fetchedAt || previous.capturedAt }
          ])
        ),
        intraday: minute.summary
          ? { ...minute.summary, fetchedAt: minute.fetchedAt, fetchFailed: minute.fetchFailed }
          : { missing: true, ...minute }
      },
      notes: [
        ...new Set([
          ...(previous.notes || []),
          '追问已检查当前报价、大盘和分时；其他周期及外围保留原数据时间，按问题补查。',
          ...[quote, market, minute].filter((v) => v.fetchFailed).map((v) => v.error)
        ])
      ].slice(-12),
      coverage: [{ label: '当前报价 / 大盘 / 分时', detail: '已检查时效，详见各项行情时间' }]
    };
  }
}

/** 只合并当前标的的查询结果，比较别的股票时不能覆盖当前个股快照。 */
export function applyEvidence(snapshot: AnalysisSnapshot, target: string, evidence: unknown[]): AnalysisSnapshot {
  if (!evidence.length) return snapshot;
  const next = { ...snapshot, timeframes: { ...snapshot.timeframes } };
  const symbol = target === 'market' ? 'sh000001' : target;
  for (const item of evidence as Array<{ tool: string; args: any; data: any }>) {
    if (!item?.data || (item.args?.symbol && item.args.symbol !== symbol) || item.data.missing || item.data.omitted)
      continue;
    const value = item.data;
    if (item.tool === 'get_quote') {
      next.quote = value;
      // 相对强弱由个股与大盘同一批报价计算，刷新一侧后不能继续沿用旧差值。
      next.relativeStrength = undefined;
    } else if (item.tool === 'get_technical' && value.summary) {
      const period = value.period?.startsWith('intraday') ? 'intraday' : value.period;
      if (['intraday', 'daily', 'weekly', 'monthly'].includes(period))
        next.timeframes![period] = { ...value.summary, fetchedAt: value.fetchedAt, fetchFailed: value.fetchFailed };
      if (period === 'daily') next.daily = next.timeframes!.daily;
    } else
      for (const key of ['market', 'sectors', 'globalMarkets', 'commodities', 'news', 'etf'])
        if (value[key]) {
          next[key] = value[key];
          if (key === 'market') next.relativeStrength = undefined;
        }
  }
  return next;
}
