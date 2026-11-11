import type { Memento } from 'vscode';

export type InterestAction = 'open' | 'period' | 'indicator';
export interface GlobalInterests {
  scope: 'user';
  stocks: Array<{ symbol: string; name: string; industry: string; views: number }>;
  sectors: Array<{ name: string; views: number; watched: number }>;
  periods: Array<{ value: string; score: number }>;
  indicators: Array<{ value: string; score: number }>;
  watchedCount: number;
  updatedAt: string;
}
interface Entry {
  day: string;
  symbol: string;
  action: InterestAction;
  value: string;
  count: number;
  at: number;
}
const KEY = 'ai.interests.v1';
const DAY = 86400000;
const PERIODS = [
  'intraday',
  'intraday5',
  'm1',
  'm5',
  'm15',
  'm30',
  'm60',
  'daily',
  'weekly',
  'monthly',
  'eastmoney',
  'chips'
];
/** 只聚合插件内主动操作；不记录源码、网页或自动刷新，30天后过期。 */
export class InterestStore {
  private entries: Entry[];
  private sectors: Record<string, { name: string; at: number }> = {};
  private write = Promise.resolve();
  constructor(
    private state: Memento,
    private enabled: () => boolean,
    private now = () => Date.now()
  ) {
    const saved = state.get<unknown>(KEY, []);
    this.entries = Array.isArray(saved) ? saved.filter((e) => this.valid(e)).slice(-600) : [];
    const sectors = state.get<any>('ai.interestSectors.v1', {});
    if (sectors && typeof sectors === 'object')
      for (const [code, item] of Object.entries<any>(sectors))
        if (
          /^(sh|sz|bj)\d{6}$/.test(code) &&
          typeof item?.name === 'string' &&
          item.name.length <= 60 &&
          Number.isFinite(item.at) &&
          this.now() - item.at < 30 * DAY &&
          item.at <= this.now()
        )
          this.sectors[code] = item;
  }
  private valid(e: any): e is Entry {
    return (
      e &&
      /^(sh|sz|bj)\d{6}$/.test(e.symbol) &&
      ['open', 'period', 'indicator'].includes(e.action) &&
      typeof e.value === 'string' &&
      e.value.length < 40 &&
      /^\d{4}-\d{2}-\d{2}$/.test(e.day) &&
      Number.isFinite(e.at) &&
      e.at <= this.now() &&
      this.now() - e.at < 30 * DAY &&
      Number.isInteger(e.count) &&
      e.count > 0 &&
      e.count <= 100
    );
  }
  record(symbol: string, action: InterestAction, value = '') {
    if (!this.enabled() || !/^(sh|sz|bj)\d{6}$/.test(symbol)) return;
    if (action === 'period' && !PERIODS.includes(value)) return;
    if (action === 'indicator' && !['macd', 'kdj', 'rsi', 'none'].includes(value)) return;
    const now = this.now(),
      day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    this.entries = this.entries.filter((e) => this.valid(e));
    const prior = this.entries.find(
      (e) => e.day === day && e.symbol === symbol && e.action === action && e.value === value
    );
    // 同类连续点击去抖，不让误触或快速切换放大偏好。
    if (prior && now - prior.at < 30000) return;
    if (prior) {
      prior.count = Math.min(100, prior.count + 1);
      prior.at = now;
    } else this.entries.push({ day, symbol, action, value, count: 1, at: now });
    this.entries = this.entries.sort((a, b) => a.at - b.at).slice(-600);
    void this.persist();
  }
  private persist() {
    const snapshot = this.entries.map((e) => ({ ...e }));
    this.write = this.write.catch(() => {}).then(() => this.state.update(KEY, snapshot));
    return this.write.catch(() => {});
  }
  async clear() {
    this.entries = [];
    this.sectors = {};
    const entries = this.persist();
    this.write = this.write.catch(() => {}).then(() => this.state.update('ai.interestSectors.v1', {}));
    await entries;
    await this.write;
  }
  noteSector(symbol: string, industry?: string) {
    if (!this.enabled() || !/^(sh|sz|bj)\d{6}$/.test(symbol) || !industry || industry.length > 60) return;
    this.sectors[symbol] = { name: industry, at: this.now() };
    this.sectors = Object.fromEntries(
      Object.entries(this.sectors)
        .filter(([, v]) => this.now() - v.at < 30 * DAY)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 100)
    );
    const value = { ...this.sectors };
    this.write = this.write.catch(() => {}).then(() => this.state.update('ai.interestSectors.v1', value));
    void this.write.catch(() => {});
  }
  /** 全局画像聚合所有标的，不随当前分析对象切换；只使用已获知的板块归属。 */
  globalSummary(
    watched: string[],
    name: (symbol: string) => string | undefined = () => undefined
  ): GlobalInterests | null {
    if (!this.enabled()) return null;
    const rows = this.entries.filter((e) => this.valid(e));
    const score = (action: InterestAction) => {
      const values = new Map<string, number>();
      for (const row of rows.filter((e) => e.action === action)) {
        const key = action === 'open' ? row.symbol : row.value;
        values.set(key, (values.get(key) || 0) + row.count * Math.pow(0.5, (this.now() - row.at) / (7 * DAY)));
      }
      return [...values]
        .sort((a, b) => b[1] - a[1])
        .map(([value, score]) => ({ value, score: Math.round(score * 10) / 10 }));
    };
    const opens = score('open'),
      counts = new Map(opens.map((s) => [s.value, s.score]));
    const stocks = [...new Set([...opens.map((s) => s.value), ...watched])]
      .slice(0, 100)
      .map((symbol) => ({
        symbol,
        name: name(symbol) || symbol,
        industry:
          this.sectors[symbol] && this.now() - this.sectors[symbol].at < 30 * DAY ? this.sectors[symbol].name : '未知',
        views: counts.get(symbol) || 0
      }));
    const sectors = new Map<string, { name: string; views: number; watched: number }>();
    for (const stock of stocks)
      if (stock.industry !== '未知') {
        const item = sectors.get(stock.industry) || { name: stock.industry, views: 0, watched: 0 };
        item.views = Math.round((item.views + stock.views) * 10) / 10;
        item.watched += Number(watched.includes(stock.symbol));
        sectors.set(item.name, item);
      }
    return {
      scope: 'user',
      stocks,
      sectors: [...sectors.values()].sort((a, b) => b.views - a.views || b.watched - a.watched),
      periods: score('period'),
      indicators: score('indicator'),
      watchedCount: watched.length,
      updatedAt: new Date(this.now()).toISOString()
    };
  }
  summary(symbol: string, watched: string[], industry?: string) {
    if (!this.enabled()) return null;
    const sector = (code: string) =>
      this.sectors[code] && this.now() - this.sectors[code].at < 30 * DAY ? this.sectors[code].name : '未知';
    const rows = this.entries.filter((e) => this.valid(e));
    const scores = (source: Entry[], action: InterestAction) => {
      const totals = new Map<string, number>();
      for (const e of source.filter((e) => e.action === action)) {
        const key = action === 'open' ? e.symbol : e.value;
        totals.set(key, (totals.get(key) || 0) + e.count * Math.pow(0.5, (this.now() - e.at) / (7 * DAY)));
      }
      return [...totals]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, score]) => ({ value, score: Math.round(score * 10) / 10 }));
    };
    const local = rows.filter((e) => e.symbol === symbol),
      periods = scores(local, 'period');
    const buckets = { short: 0, medium: 0, long: 0 };
    for (const p of periods) {
      if (p.value.startsWith('intraday') || /^m\d+$/.test(p.value)) buckets.short += p.score;
      if (p.value === 'weekly') buckets.medium += p.score;
      if (p.value === 'monthly') buckets.long += p.score;
    }
    const ranking = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
    // 日线点击不能单独判断长短线，但也不能忽略大量日线点击而把少量月线操作判作长期偏好。
    const total = ranking.reduce((s, [, v]) => s + v, 0) + (periods.find((p) => p.value === 'daily')?.score || 0);
    const hint =
      total >= 3 && ranking[0][1] / total >= 0.65
        ? { short: '近期/短线', medium: '阶段/中线', long: '长期背景' }[ranking[0][0]]
        : '不确定或多周期关注';
    return {
      currentSymbol: symbol,
      inWatchlist: watched.includes(symbol),
      currentIndustry: industry || '未知，不推测',
      watchlistSample: watched.slice(0, 8).map((code) => ({ symbol: code, industry: sector(code) })),
      frequentlyViewed: scores(rows, 'open').map((e) => ({ ...e, industry: sector(e.value) })),
      currentViews: local.filter((e) => e.action === 'open').reduce((s, e) => s + e.count, 0),
      periods,
      indicators: scores(local, 'indicator'),
      horizonHint: hint,
      confidence: hint === '不确定或多周期关注' ? '不足' : '低（仅浏览行为）',
      note: '近30天本机聚合，7天半衰期；仅主动切换计数。日线或单个指标不能单独确定投资周期；不代表持仓、买卖意愿或风险承受力。用户当前问题和明确更正优先。'
    };
  }
}
