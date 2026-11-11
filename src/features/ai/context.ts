import type { AnalysisSnapshot, PublicMarketSection } from './types';
import type { ContextDependencies } from './dependencies';
import {
  summarizeChart,
  summarizeIntraday,
  technical,
  cleanBars,
  returnsOf,
  comparableReturns,
  dayOf
} from './technical-context';
import type { Period, ChartInput } from './technical-context';
import { AiHistoryProvider } from './history-data';
import { isEtfCandidate } from '../funds/etf-quote';
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
class AnalysisContext {
  declare now: () => Date;
  declare quoteProvider: AiQuoteProvider;
  declare chartProvider: ChartProvider;
  declare environment: AnalysisEnvironment;
  declare stocks: ContextDependencies['stocks'];
  declare historyProvider: AiHistoryProvider;

  constructor({
    stocks,
    market,
    globals,
    commodities,
    news,
    chartProvider = new ChartProvider(undefined, 1),
    quoteProvider = new AiQuoteProvider(),
    historyProvider = new AiHistoryProvider(),
    now = () => new Date(),
    environment = new AnalysisEnvironment({ market, globals, commodities, news, now })
  }: ContextDependencies) {
    Object.assign(this, { stocks, market, chartProvider, quoteProvider, historyProvider, now, environment });
  }
  async collect(target: string, signal?: AbortSignal): Promise<AnalysisSnapshot> {
    const symbol = target === 'market' ? 'sh000001' : target;
    if (!/^(?:sh|sz|bj)\d{6}$/.test(symbol)) throw new Error('当前 AI 分析支持 A 股、场内 ETF 和沪深指数。');
    const data: AnalysisSnapshot = {
      target: target === 'market' ? '沪深大盘（综合四大指数；分时以上证为观察样本）' : symbol,
      capturedAt: this.now().toISOString(),
      timeZone: 'Asia/Shanghai',
      notes: []
    };
    const now = this.now();
    // A request-local map shares the target's daily series with benchmark comparisons.
    const requests = new Map<string, ReturnType<typeof attempt<ChartInput>>>();
    const chart = (code: string, mode: string) => {
      const key = code + mode;
      if (!requests.has(key))
        requests.set(
          key,
          attempt((s) => this.chartProvider.load(code, mode, s), signal, 12000)
        );
      return requests.get(key)!;
    };
    const multi = async (code: string): Promise<Record<Period, ReturnType<typeof summarizeChart>>> =>
      Object.fromEntries(
        await Promise.all(
          (['monthly', 'weekly', 'daily'] as Period[]).map(async (mode) => {
            const result = await chart(code, mode);
            return [mode, result.ok ? summarizeChart(result.value, mode, now) : null];
          })
        )
      ) as Record<Period, ReturnType<typeof summarizeChart>>;
    const targetTask = multi(symbol);
    const minuteTask = (async () => {
      const [five, one] = await Promise.all([chart(symbol, 'intraday5'), chart(symbol, 'intraday')]);
      const summary = five.ok ? summarizeIntraday(five.value, now) : null;
      const current = one.ok ? summarizeIntraday(one.value, now) : null;
      if (
        current &&
        (!summary || current.date > summary.date || (current.date === summary.date && current.time >= summary.time))
      ) {
        if (five.ok && one.ok && summary && five.value.adjustment === one.value.adjustment) {
          const combined = summarizeIntraday(
            {
              ...one.value,
              bars: [
                ...five.value.bars.filter((b) => (b.date || b.time.slice(0, 10)) < current.date),
                ...one.value.bars.map((b) => ({ ...b, date: current.date }))
              ]
            },
            now
          );
          if (combined) return { ...combined, historySource: five.value.source };
        }
        return current;
      }
      return summary;
    })();
    const benchmarkTask = Promise.all(
      BENCHMARKS.map(async (code) => {
        if (target === 'market') return { symbol: code, timeframes: await multi(code) };
        const result = await chart(code, 'daily');
        return { symbol: code, daily: result.ok ? summarizeChart(result.value, 'daily', now) : null };
      })
    );
    const backgroundTask = (async () => {
      const base = await attempt(
        (s) => this.environment.load(symbol, s, this.stocks?.quotes.get(symbol)?.name),
        signal,
        20000
      );
      return base.ok ? { ok: true as const, value: await this.enrichHistory(base.value, signal, now) } : base;
    })();
    const [quoteResult, timeframes, intraday, histories, background] = await Promise.all([
      attempt((s) => this.quoteProvider.load([...new Set([symbol, ...BENCHMARKS])], s), signal, 18000),
      targetTask,
      minuteTask,
      benchmarkTask,
      backgroundTask
    ]);
    if (signal?.aborted) throw abortError();
    const live = quoteResult.ok && quoteResult.value.quotes.get(symbol);
    const cached = this.stocks?.quotes.get(symbol);
    const quote = live || cached;
    if (quote) data.quote = { ...pick(quote, QUOTE_KEYS), source: quote.source || '腾讯行情', cached: !live };
    if (!live) data.notes.push(quote ? '最新报价获取失败，报价使用缓存，需核对报价时间。' : '最新报价不可用。');
    data.timeframes = Object.fromEntries(Object.entries({ ...timeframes, intraday }).filter(([, v]) => v));
    data.daily = data.timeframes.daily;
    for (const [mode, label] of [
      ['monthly', '月线'],
      ['weekly', '周线'],
      ['daily', '日线'],
      ['intraday', '分时']
    ])
      if (!data.timeframes[mode]) data.notes.push(`${label}缺失，不推断该周期走势。`);
    const adjustments = new Set(
      Object.values(timeframes)
        .filter((v) => v !== null)
        .map((v) => v.adjustment || '未知')
    );
    if (adjustments.size > 1 || adjustments.has('未知'))
      data.notes.push('各周期复权口径不同或未知，不能直接比较跨周期绝对价位。');
    const dailyResult = await chart(symbol, 'daily');
    const etf = quote?.etf || (dailyResult.ok ? dailyResult.value.etf : null);
    if (isEtfCandidate(symbol))
      data.etf = {
        confirmed: Boolean(etf),
        ...(etf
          ? pick(etf, ['price', 'iopv', 'premiumRate', 'quoteTimestamp', 'source', 'notice'])
          : { missing: true }),
        trackingIndex: '未取得已确认的跟踪指数，不推断跟踪误差；大盘仅作环境参考。'
      };
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
    data.market.history = histories.map((h) =>
      target === 'market'
        ? {
            symbol: h.symbol,
            timeframes: Object.fromEntries(
              Object.entries(h.timeframes || {})
                .filter(([, v]) => v)
                .map(([mode, v]) => [
                  mode,
                  {
                    ...pick(v!, ['source', 'adjustment', 'date', 'state', 'confirmedThrough', 'forming']),
                    sample: v!.sample,
                    returns: v!.returns,
                    indicators: v!.indicators,
                    range: v!.ranges.prior20
                  }
                ])
            )
          }
        : {
            symbol: h.symbol,
            ...(h.daily
              ? {
                  source: h.daily.source,
                  adjustment: h.daily.adjustment,
                  state: h.daily.state,
                  returns: h.daily.returns,
                  relative: data.daily ? comparableReturns(data.daily.returns, h.daily.returns) : []
                }
              : { missing: true })
          }
    );
    const industryHistory = data.sectors?.history;
    if (industryHistory?.returns && data.daily)
      industryHistory.relative = comparableReturns(data.daily.returns, industryHistory.returns);
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
      !Object.keys(data.timeframes).length &&
      !(target === 'market' && (data.market.amount !== undefined || benchmarks.some((q) => !q.missing)))
    )
      throw new Error('暂无可用行情（该标的），未调用 AI。请稍后重新分析。');
    data.coverage = [
      { label: '个股 / 指数', detail: data.quote || data.daily ? '已获取' : '缺失' },
      {
        label: '多周期',
        detail: (
          [
            ['monthly', '月'],
            ['weekly', '周'],
            ['daily', '日'],
            ['intraday', '分时']
          ] as const
        )
          .map(([mode, label]) => `${label}${data.timeframes![mode] ? '✓' : '缺失'}`)
          .join(' / ')
      },
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
        detail: `${data.globalMarkets?.quotes?.length || 0}/${data.globalMarkets?.requested || 10} 指数 · ${data.globalMarkets?.futures?.length || 0}/2 期货参考`
      },
      { label: '商品', detail: `${data.commodities?.quotes?.length || 0}/4` },
      { label: '快讯', detail: `${data.news?.items?.length || 0} 条` }
    ];
    data.notes.push('以上为各项标注时间的行情；获取时间不代表报价时间，旧报价和未完成周期不能当作当前已确认走势。');
    return data;
  }
  async enrichHistory(
    env: PublicMarketSection,
    signal: AbortSignal | undefined,
    now: Date
  ): Promise<PublicMarketSection> {
    const industry = env.sectors?.rows?.find((r) => r.name === env.sectors?.industry);
    const tasks = [
      ...(industry?.code ? [{ id: '90.' + industry.code, kind: 'industry', row: industry }] : []),
      ...(env.globalMarkets?.quotes || []).slice(0, 10).map((row) => ({ id: row.id, kind: 'global', row }))
    ];
    // Three short parallel batches; failed ancillary history must not discard the existing environment.
    const results: Record<string, any>[] = [];
    const enriched = await attempt(
      async (s) => {
        let index = 0;
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            while (index < tasks.length && !s.aborted) {
              const task = tasks[index++],
                result = await attempt((inner) => this.historyProvider.load(task.id, inner), s, 2500);
              const rows = result.ok ? cleanBars(result.value, 'daily', now) : [];
              // UTC-12 is the last calendar timezone: 36h after a source date's UTC midnight
              // guarantees that date has ended everywhere. Conservative, but never assumes a foreign session closed.
              const closeTime = Date.parse(dayOf(now) + 'T15:00:00+08:00');
              const bars =
                task.kind === 'global'
                  ? rows.filter((b) => Date.parse(b.time + 'T00:00:00Z') + 36 * 3600000 <= now.getTime())
                  : rows.filter(
                      (b) =>
                        b.time < dayOf(now) ||
                        (task.row.timestamp * 1000 >= closeTime &&
                          task.row.timestamp * 1000 <= now.getTime() &&
                          b.time === dayOf(now))
                    );
              results.push({
                kind: task.kind,
                name: task.row.name,
                id: task.id,
                ...(result.ok && bars.length
                  ? {
                      ...pick(result.value, ['source', 'cached', 'fetchedAt']),
                      through: bars.at(-1)!.time,
                      returns: returnsOf(bars),
                      ...(task.kind === 'global'
                        ? { scope: '只用源日期已过36小时的日K，保守避开跨时区未收盘数据；以through为准' }
                        : {})
                    }
                  : { missing: true })
              });
            }
          })
        );
        return results;
      },
      signal,
      8000
    );
    return {
      ...env,
      sectors: env.sectors
        ? {
            ...env.sectors,
            history: results.find((r) => r.kind === 'industry') || { missing: true }
          }
        : undefined,
      globalMarkets: env.globalMarkets
        ? {
            ...env.globalMarkets,
            history: results.filter((r) => r.kind === 'global'),
            historyIncomplete: !enriched.ok || results.some((r) => r.kind === 'global' && r.missing)
          }
        : undefined
    };
  }
}
export { AnalysisContext, SYSTEM, technical, pick, BENCHMARKS };
