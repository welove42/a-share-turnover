import { AnalysisContext } from './context';
import { attempt, abortError, pick } from './data';
import { summarizeChart, summarizeIntraday, dayOf, type Period } from './technical-context';
import { isEtfCandidate } from '../funds/etf-quote';
import type { AnalysisSnapshot, ToolDefinition } from './types';
import { stockSession } from '../turnover/market';
import { supportsTurnover } from '../watchlist/quotes';

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

/** 明确要求的周期先补查，不依赖模型是否选择调用工具。 */
function requestedPeriods(question: string): Period[] {
  const periods: Period[] = [];
  if (/日线|日\s*k|近(?:几|多|\d+)日|近期走势|最近走势|洗盘|出货/i.test(question)) periods.push('daily');
  if (/周线|周\s*k/i.test(question)) periods.push('weekly');
  if (/月线|月\s*k/i.test(question)) periods.push('monthly');
  return periods;
}

export interface QueryData {
  missingQueries?(
    snapshot: AnalysisSnapshot,
    target: string,
    question: string
  ): Array<{ name: QueryName; args: Record<string, unknown>; label: string }>;
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

  /** 关键上下文确有缺口时由宿主先查一次，不依赖模型主动提出；已有可用数据不重复请求。 */
  missingQueries(snapshot: AnalysisSnapshot, target: string, question: string) {
    const queries: Array<{ name: QueryName; args: Record<string, unknown>; label: string }> = [];
    if (explanationOnly(question) && !/分析|走势/.test(question)) return queries;
    const sector = snapshot.sectors;
    if (
      supportsTurnover(target) &&
      sector?.applicable !== false &&
      (!sector?.industry ||
        sector.missing ||
        sector.fetchFailed ||
        !sector.rows?.some(
          (r) =>
            (r.type === '所属行业' || r.name === sector.industry) &&
            Number.isFinite(r.percent) &&
            (r.timestamp || r.time)
        ))
    )
      queries.push({ name: 'get_environment', args: { scope: 'sector' }, label: '所属板块' });
    const market = snapshot.market;
    if (
      !market ||
      market.missing ||
      market.fetchFailed ||
      !Number.isFinite(market.amount) ||
      !market.markets?.some((m) => Number.isFinite(m.breadth?.advancing) && Number.isFinite(m.breadth?.declining)) ||
      !market.benchmarks?.some((q) => Number.isFinite(q.price))
    )
      queries.push({ name: 'get_market', args: {}, label: '大盘与涨跌家数' });
    for (const [period, label] of [
      ['daily', '日线'],
      ['weekly', '周线'],
      ['monthly', '月线'],
      ['intraday', '分时']
    ]) {
      const value = snapshot.timeframes?.[period];
      if (!value || value.missing || value.fetchFailed)
        queries.push({
          name: 'get_technical',
          args: { period, ...(period === 'intraday' ? {} : { bars: period === 'daily' ? 10 : 6 }) },
          label
        });
    }
    if (!snapshot.globalMarkets?.quotes?.length)
      queries.push({ name: 'get_environment', args: { scope: 'global' }, label: '全球市场' });
    return queries;
  }

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
      // “请求成功但数据缺失”不能作为有效行情缓存，后续主动分析仍可补查。
      if (!value.missing && !value.fetchFailed && !value.market?.missing && !value.sectors?.missing)
        this.cache.set(key, { at: time, value });
      return value;
    }
    const issue = /HTTP\s*(401|403|429|501)/i.exec(result.error)?.[0];
    const reason = issue
      ? `（数据源包含 ${issue.toUpperCase()}）`
      : /超时/.test(result.error)
        ? '（数据源超时）'
        : /冷却|暂停重复请求/.test(result.error)
          ? '（数据源处于失败冷却）'
          : '';
    if (old && time >= old.at && time - old.at < 7 * 86400000)
      return {
        ...old.value,
        ...(old.value.globalMarkets
          ? {
              globalMarkets: {
                ...old.value.globalMarkets,
                fetchFailed: true,
                quotes: (old.value.globalMarkets.quotes || []).map((q) => ({ ...q, currentReference: false })),
                futures: (old.value.globalMarkets.futures || []).map((q) => ({
                  ...q,
                  currentReference: false,
                  fetchFailed: true
                }))
              }
            }
          : {}),
        cached: true,
        fetchFailed: true,
        error: `本次查询失败${reason}，以下为原时间数据，不能当作最新行情。`
      };
    return {
      missing: true,
      fetchFailed: true,
      error: `本次数据查询失败${reason}，不能推断缺失值。`,
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
    const ttl =
      name === 'get_environment' && scope === 'global'
        ? 0
        : ['get_quote', 'get_etf', 'get_market', 'get_technical'].includes(name)
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
      const [env, benchmarks] = await Promise.all([
        this.source.environment.load(
          code,
          querySignal,
          args.query || this.source.stocks?.quotes.get(code)?.name,
          sections
        ),
        name === 'get_market'
          ? attempt(
              (s) => this.source.quoteProvider.load(['sh000001', 'sz399001', 'sz399006', 'sh000300'], s),
              querySignal,
              12000
            )
          : Promise.resolve(null)
      ]);
      if (name === 'get_market')
        return {
          market: {
            ...(env.market || { turnoverMissing: true }),
            benchmarks: ['sh000001', 'sz399001', 'sz399006', 'sh000300'].map((symbol) => {
              const quote = benchmarks?.ok ? benchmarks.value.quotes.get(symbol) : null;
              return quote
                ? {
                    ...pick(quote, [
                      'symbol',
                      'name',
                      'price',
                      'percent',
                      'delta',
                      'previousClose',
                      'date',
                      'timestamp'
                    ]),
                    source: quote.source || '腾讯行情'
                  }
                : { symbol, missing: true };
            })
          }
        };
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
    if (explanationOnly(question) && !/分析|走势|是.*还是/.test(question)) return previous;
    const periods = requestedPeriods(question);
    const [quote, market, minute, global, sector, ...technical] = await Promise.all([
      this.execute('get_quote', {}, target, signal),
      this.execute('get_market', {}, target, signal),
      this.execute('get_technical', { period: 'intraday' }, target, signal),
      this.execute('get_environment', { scope: 'global' }, target, signal),
      this.execute('get_environment', { scope: 'sector' }, target, signal),
      ...periods.map((period) =>
        this.execute('get_technical', { period, bars: period === 'daily' ? 10 : 6 }, target, signal)
      )
    ]);
    const updatedPeriods = Object.fromEntries(
      periods.map((period, index) => {
        const value = technical[index];
        const previousPeriod = previous.timeframes?.[period];
        return [
          period,
          value.summary
            ? {
                ...value.summary,
                recentBars: value.bars?.slice().reverse(),
                recentBarsOrder: '新到旧',
                fetchedAt: value.fetchedAt,
                fetchFailed: value.fetchFailed
              }
            : previousPeriod && !previousPeriod.missing
              ? {
                  ...previousPeriod,
                  fetchedAt: previousPeriod.fetchedAt || previous.capturedAt,
                  fetchFailed: true,
                  error: value.error
                }
              : { missing: true, ...value }
        ];
      })
    );
    const resolved = new Set(periods.filter((_, index) => technical[index]?.summary && !technical[index]?.fetchFailed));
    // 各区块保留自己的时间；更新报价不能让旧日/周/月线看起来也刚更新。
    return {
      ...previous,
      capturedAt: new Date(this.now()).toISOString(),
      quote,
      market: market.market || { missing: true },
      globalMarkets: global.globalMarkets
        ? {
            ...global.globalMarkets,
            ...(global.fetchFailed
              ? {
                  fetchFailed: true,
                  error: global.error,
                  quotes: (global.globalMarkets.quotes || []).map((q) => ({ ...q, currentReference: false })),
                  futures: (global.globalMarkets.futures || []).map((q) => ({
                    ...q,
                    currentReference: false,
                    fetchFailed: true
                  }))
                }
              : {})
          }
        : {
            ...previous.globalMarkets,
            fetchFailed: true,
            error: global.error || '外围刷新失败',
            quotes: (previous.globalMarkets?.quotes || []).map((q) => ({ ...q, currentReference: false })),
            futures: (previous.globalMarkets?.futures || []).map((q) => ({
              ...q,
              currentReference: false,
              fetchFailed: true
            }))
          },
      commodities: global.commodities || previous.commodities,
      sectors: sector.sectors || { ...previous.sectors, fetchFailed: true, error: sector.error },
      relativeStrength: undefined,
      daily: updatedPeriods.daily || previous.daily,
      timeframes: {
        ...Object.fromEntries(
          Object.entries(previous.timeframes || {}).map(([period, values]) => [
            period,
            { ...values, fetchedAt: values?.fetchedAt || previous.capturedAt }
          ])
        ),
        ...updatedPeriods,
        intraday: minute.summary
          ? { ...minute.summary, fetchedAt: minute.fetchedAt, fetchFailed: minute.fetchFailed }
          : { missing: true, ...minute }
      },
      notes: [
        ...new Set([
          ...(previous.notes || []).filter(
            (note) =>
              !(
                (resolved.has('daily') && note.startsWith('日线缺失')) ||
                (resolved.has('weekly') && note.startsWith('周线缺失')) ||
                (resolved.has('monthly') && note.startsWith('月线缺失'))
              )
          ),
          '追问已检查报价、大盘、分时、所属板块及美日韩外围（含纳指100和日经期货参考）；各项按实际报价时间解读。',
          ...[quote, market, minute, global, sector, ...technical].filter((v) => v.fetchFailed).map((v) => v.error)
        ])
      ].slice(-12),
      coverage: [
        {
          label: '本轮行情',
          detail: `已检查报价 / 大盘 / 分时 / 板块 / 美日韩外围${periods.length ? ' / ' + periods.map((p, index) => `${{ daily: '日线', weekly: '周线', monthly: '月线' }[p]}${technical[index]?.fetchFailed ? (technical[index]?.summary || (previous.timeframes?.[p] && !previous.timeframes[p]?.missing) ? '（缓存）' : '缺失') : '已获取'}`).join(' / ') : ''}，详见数据时间`
        }
      ]
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
        next.timeframes![period] = {
          ...value.summary,
          ...(value.bars?.length ? { recentBars: value.bars.slice().reverse(), recentBarsOrder: '新到旧' } : {}),
          fetchedAt: value.fetchedAt,
          fetchFailed: value.fetchFailed
        };
      if (period === 'daily') next.daily = next.timeframes!.daily;
    } else
      for (const key of ['market', 'sectors', 'globalMarkets', 'commodities', 'news', 'etf'])
        if (value[key]) {
          next[key] = value[key];
          if (key === 'market') next.relativeStrength = undefined;
        }
  }
  // 成功补齐的旧缺失提示必须一起撤销，避免模型把旧提示当作当前状态。
  next.notes = (snapshot.notes || []).filter(
    (note) =>
      !Object.entries({ daily: '日线', weekly: '周线', monthly: '月线', intraday: '分时' }).some(
        ([period, label]) =>
          note.startsWith(label + '缺失') &&
          next.timeframes?.[period] &&
          !next.timeframes[period].missing &&
          !next.timeframes[period].fetchFailed
      )
  );
  return next;
}
