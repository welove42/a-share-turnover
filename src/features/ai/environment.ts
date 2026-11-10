import type { EnvironmentDependencies } from './dependencies';
import type { AnalysisSnapshot, PublicMarketSection } from './types';
import type { GlobalQuote, CommodityQuote, NewsArticle } from '../../shared/types';
type CachedResult<T> =
  | { ok: true; value: T; cached: boolean; fetchedAt: number; error?: string }
  | { ok: false; error: string; cached?: boolean; fetchedAt?: number };
import { MarketProvider } from '../turnover/provider';
import { GlobalIndexProvider, BUILTIN_INDICES, validId, isGlobalQuote } from '../global-indices/data';
import { CommodityProvider, entryFor, isCommodityQuote } from '../commodities/data';
import { NewsProvider, isArticle } from '../news/data';
import { AiSectorProvider } from './sector-data';
import { marketTemperature } from '../temperature/service';
import { session } from '../turnover/market';
import { pick, attempt, abortError, quoteTime } from './data';
const WORLD_IDS = [
  '100.NDX',
  '100.SPX',
  '100.DJIA',
  '100.HSI',
  '100.N225',
  '100.KS11',
  '100.GDAXI',
  '100.FTSE',
  '100.FCHI',
  '100.UDI'
];
const COMMODITY_CODES = ['XAU', 'OIL', 'CAD', 'XAG'];
const MAX_AGE = 7 * 86400000;
const MACRO =
  /美联储|央行|降息|加息|利率|通胀|非农|就业|CPI|PPI|PMI|GDP|关税|财政|货币|汇率|美元|人民币|美股|港股|日经|韩国|欧洲|欧央行|原油|黄金|油价|地缘|战争|停火|制裁|选举|外贸|出口|进口|刺激|监管|证监会/i;
function headlines(items: NewsArticle[], names: Array<string | undefined>, now: number) {
  const rows = items
    .filter(isArticle)
    .filter((n) => n.publishedAt <= now + 300000 && now - n.publishedAt <= 48 * 3600000)
    .sort((a, b) => b.publishedAt - a.publishedAt);
  const matching = rows.filter((n) =>
    names.some((name) => typeof name === 'string' && name.length > 0 && (n.title + n.body + n.stocks).includes(name))
  );
  const macro = rows.filter((n) => MACRO.test(n.title + n.body));
  const selected = [
    ...new Map([...matching.slice(0, 6), ...macro.slice(0, 8), ...rows].map((n) => [n.key, n])).values()
  ].slice(0, 12);
  return selected.map((n) => ({
    title: n.title.slice(0, 240),
    summary: n.body.slice(0, 600),
    publishedAt: new Date(n.publishedAt).toISOString(),
    source: '东方财富快讯',
    related: matching.includes(n),
    id: n.id
  }));
}
class AnalysisEnvironment {
  declare cache: Map<string, { value: unknown; time: number }>;
  declare worldCache: Map<string, { q: GlobalQuote; fetchedAt: number }>;
  declare commodityCache: Map<string, { q: CommodityQuote; fetchedAt: number }>;
  declare now: () => Date;
  declare timeoutMs: number;
  declare globals: EnvironmentDependencies['globals'];
  declare market: EnvironmentDependencies['market'];
  declare marketProvider: MarketProvider;
  declare globalProvider: GlobalIndexProvider;
  declare commodityProvider: CommodityProvider;
  declare sectorProvider: AiSectorProvider;
  declare newsProvider: NewsProvider;
  declare commodities: EnvironmentDependencies['commodities'];
  declare news: EnvironmentDependencies['news'];

  constructor({
    market,
    globals,
    commodities,
    news,
    now = () => new Date(),
    marketProvider = new MarketProvider({ now }),
    globalProvider = new GlobalIndexProvider({ now: () => now().getTime() }),
    commodityProvider = new CommodityProvider(),
    newsProvider = new NewsProvider(),
    sectorProvider = new AiSectorProvider({ now: () => now().getTime() }),
    timeoutMs = 18000
  }: EnvironmentDependencies = {}) {
    Object.assign(this, {
      market,
      globals,
      commodities,
      news,
      now,
      marketProvider,
      globalProvider,
      commodityProvider,
      newsProvider,
      sectorProvider,
      timeoutMs
    });
    this.cache = new Map();
    this.worldCache = new Map();
    this.commodityCache = new Map();
  }
  async fetch<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    ttl = 60000
  ): Promise<CachedResult<T>> {
    const now = this.now().getTime(),
      old = this.cache.get(key);
    if (old && now >= old.time && now - old.time < ttl)
      return { ok: true, value: old.value as T, fetchedAt: old.time, cached: true };
    const result = await attempt(operation, signal, this.timeoutMs);
    if (signal?.aborted) throw abortError();
    if (result.ok) {
      this.cache.set(key, { value: result.value, time: now });
      if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value!);
      return { ...result, cached: false, fetchedAt: now };
    }
    if (old && now >= old.time && now - old.time <= MAX_AGE)
      return { ok: true, value: old.value as T, cached: true, fetchedAt: old.time, error: '本次获取失败，使用原快照' };
    return result;
  }
  async load(
    symbol: string,
    signal?: AbortSignal,
    name?: string,
    sections = ['market', 'global', 'commodities', 'sectors', 'news']
  ) {
    const wants = (section: string) => sections.includes(section);
    const skipped = Promise.resolve({
      ok: false as const,
      error: '本次未查询',
      fetchedAt: undefined as number | undefined,
      cached: false
    });
    const now = this.now(),
      ms = now.getTime();
    // A fixed cross-market baseline is always collected, regardless of what the
    // user has expanded/selected in the watchlist; user indices are supplementary.
    const allIds = [...new Set([...WORLD_IDS, ...(this.globals?.selectedIds || []).filter(validId)])],
      ids = allIds.slice(0, 24);
    const localSnapshot = this.market?.snapshot;
    const receivedWorld = new Map<string, GlobalQuote>();
    const recentSnapshot =
      localSnapshot &&
      !this.market?.state?.error &&
      ms - Date.parse(localSnapshot.fetchedAt) >= 0 &&
      ms - Date.parse(localSnapshot.fetchedAt) < 20000;
    const [market, world, commodities, sectors, news] = await Promise.all([
      !wants('market')
        ? skipped
        : recentSnapshot
          ? Promise.resolve({ ok: true as const, value: localSnapshot, cached: true, error: undefined })
          : this.fetch('market', (s) => this.marketProvider.load(s), signal, 20000),
      !wants('global')
        ? skipped
        : this.fetch(
            'world:' + ids.join(','),
            (s) =>
              this.globalProvider.load(ids, s, (q) => {
                if (!s.aborted) receivedWorld.set(q.id, q);
              }),
            signal
          ),
      !wants('commodities')
        ? skipped
        : this.fetch('commodities', (s) => this.commodityProvider.load(COMMODITY_CODES, s), signal),
      !wants('sectors') ? skipped : attempt((s) => this.sectorProvider.load(symbol, s), signal, this.timeoutMs),
      !wants('news') ? skipped : this.fetch('news', (s) => this.newsProvider.load(s), signal, 120000)
    ]);
    if (signal?.aborted) throw abortError();
    const notes: string[] = [],
      data: Partial<AnalysisSnapshot> = {};
    const snapshot = market.ok ? market.value : localSnapshot;
    if (snapshot) {
      const fallback = !market.ok || Boolean(market.error);
      data.market = {
        ...pick(snapshot, ['date', 'fetchedAt', 'previousDate', 'comparisonTime', 'amount']),
        source: '腾讯沪深 A 股行情',
        amountUnit: '元',
        cached: !market.ok || Boolean(market.cached),
        fetchFailed: fallback,
        sameTime: pick(snapshot.sameTime, ['percent', 'current', 'previous', 'delta']),
        markets: (snapshot.markets || []).slice(0, 2).map((m) => ({
          ...pick(m, ['symbol', 'amount', 'percent', 'timestamp']),
          breadth: pick(m.breadth, ['advancing', 'declining', 'unchanged'])
        }))
      };
      const temperature = marketTemperature(
        snapshot,
        { cached: fallback, paused: false, error: '' },
        session(now, this.market?.config?.additionalClosedDates || []),
        now
      );
      data.market.temperature = {
        ...pick(temperature, ['score', 'label', 'reason', 'date', 'comparisonTime', 'averagePercent', 'volumePercent']),
        method: '涨跌家数60% + 两市A股指数平均涨幅25% + 同刻放缩量15%，插件自定义情绪指标'
      };
      if (fallback) notes.push('大盘成交额接口失败，沿用原快照；以 fetchedAt 和交易日期判断时效。');
    } else notes.push('大盘成交额、涨跌家数和温度未获取到。');
    const worldRows: PublicMarketSection[] = [],
      missing: string[] = [];
    for (const id of ids) {
      const partial = receivedWorld.get(id),
        fresh = partial || (world.ok && world.value.quotes?.get(id));
      if (fresh && isGlobalQuote(fresh))
        this.worldCache.set(id, { q: fresh, fetchedAt: partial ? ms : world.fetchedAt! });
      const stored = this.worldCache.get(id),
        q = stored?.q || this.globals?.quotes?.get(id);
      if (!isGlobalQuote(q) || q.timestamp * 1000 > ms + 300000 || ms - q.timestamp * 1000 > MAX_AGE) {
        missing.push(BUILTIN_INDICES.find((e) => e.id === id)?.name || id);
        continue;
      }
      worldRows.push({
        ...pick(q, ['id', 'name', 'region', 'price', 'percent', 'delta', 'previousClose']),
        ...quoteTime(q.timestamp, ms, q.timestampKind),
        source: q.source === 'sina' ? '新浪财经' : '东方财富',
        cached: !fresh || (!partial && Boolean(world.cached)),
        fetchedAt: stored?.fetchedAt ? new Date(stored.fetchedAt).toISOString() : undefined
      });
    }
    if (this.worldCache.size > 200) this.worldCache.delete(this.worldCache.keys().next().value!);
    data.globalMarkets = {
      scope: '全球主要市场代表指数和美元指数，并非全球全部市场',
      requested: ids.length,
      quotes: worldRows,
      missing,
      extraIndicesOmitted: allIds.length - ids.length,
      timing:
        '各市场交易时区不同，最新可用报价可能属于上一交易日；请逐项核对 time，不视为同一时刻同时交易。来源更新时间不能当作交易所逐笔时间。'
    };
    if (missing.length) notes.push('部分全球指数不可用：' + missing.join('、'));
    const commodityRows: PublicMarketSection[] = [],
      missingCommodities: string[] = [];
    for (const code of COMMODITY_CODES) {
      const fresh = commodities.ok && commodities.value.quotes?.get(code);
      if (fresh && isCommodityQuote(fresh))
        this.commodityCache.set(code, { q: fresh, fetchedAt: commodities.fetchedAt! });
      const stored = this.commodityCache.get(code),
        q = stored?.q || this.commodities?.quotes?.get(code),
        entry = entryFor(code);
      if (!isCommodityQuote(q) || q.timestamp * 1000 > ms + 300000 || ms - q.timestamp * 1000 > MAX_AGE) {
        missingCommodities.push(entry?.name || code);
        continue;
      }
      commodityRows.push({
        ...pick(q, ['code', 'price', 'percent', 'delta', 'previousClose']),
        name: entry!.name,
        unit: entry!.unit,
        ...quoteTime(q.timestamp, ms),
        source: '新浪财经 CFD 参考行情',
        cached: !fresh || Boolean(commodities.cached),
        fetchedAt: stored?.fetchedAt ? new Date(stored.fetchedAt).toISOString() : undefined
      });
    }
    data.commodities = {
      quotes: commodityRows,
      missing: missingCommodities,
      note: '参考报价，不能等同交易所可成交价格。'
    };
    if (sectors.ok) {
      const s = sectors.value;
      data.sectors = {
        ...pick(s, [
          'applicable',
          'industry',
          'industryCached',
          'reason',
          'source',
          'fetchedAt',
          'cached',
          'cacheReason',
          'total',
          'truncated',
          'quoteFailure'
        ]),
        amountUnit: '元',
        scope: '通过此股票代码查询所属行业、概念、地域和风格标签；相关标签不等同独立行业，不用领涨榜替代归属。',
        rows: (s.rows || []).map((row) => ({
          ...pick(row, ['code', 'name', 'price', 'percent', 'amount', 'turnoverRate', 'advancing', 'declining']),
          ...quoteTime(row.timestamp, ms),
          type: row.name === s.industry ? '所属行业' : '相关板块 / 标签'
        }))
      };
      if (s.applicable && (!s.rows?.some((r) => Number.isFinite(r.percent) && r.timestamp) || s.quoteFailure))
        notes.push('已取得板块归属，但板块行情不完整；不能据此判断当前板块强弱。');
      if (s.cached) notes.push('所属板块使用缓存，保留原始行情时间。');
    } else {
      data.sectors = {
        applicable: true,
        rows: [],
        missing: true,
        reason: '所属板块查询失败，不能依据股票名称猜测归属。'
      };
      notes.push(data.sectors.reason);
    }
    const articles = news.ok ? news.value : this.news?.items || [];
    data.news = {
      items: headlines(
        articles,
        [name, symbol.slice(2), data.sectors.industry, ...(data.sectors.rows || []).slice(0, 40).map((r) => r.name)],
        ms
      ),
      source: '东方财富快讯',
      cached: !news.ok || Boolean(news.cached),
      fetchedAt: news.fetchedAt ? new Date(news.fetchedAt).toISOString() : undefined,
      scope:
        '最近48小时公开快讯选摘，优先标的、所属板块与宏观消息；非全网新闻或完整基本面研究，标题不等于已证实的市场影响。'
    };
    if (!data.news.items.length) notes.push('未取得近48小时可用财经快讯，不推断政策和事件。');
    return { ...data, notes };
  }
}
export { AnalysisEnvironment, WORLD_IDS, COMMODITY_CODES, headlines };
