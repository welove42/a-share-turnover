import * as vscode from 'vscode';
import type { WatchlistController } from './controller';
import {
  WatchlistHistoryProvider,
  validHistory,
  listMetrics,
  type ListHistory,
  type ListHistoryProvider,
  type ListQuote
} from './insights-data';

interface CachedHistory {
  date: string;
  at: number;
  data: ListHistory;
}
const KEY = 'stockListHistoryV1';
const DAY = 86400000;

/** 只增强 TreeItem 的描述/悬停；不改标签、图标、命令、分组或拖拽协议。 */
export class StockListInsights implements vscode.Disposable {
  private cache = new Map<string, CachedHistory>();
  private attempts = new Map<string, { date: string; until: number; error?: string }>();
  private queue = new Map<string, string>();
  private active = new Map<string, AbortController>();
  private listeners: vscode.Disposable[];
  private disposed = false;
  private writing = Promise.resolve();
  constructor(
    private owner: WatchlistController,
    private provider: ListHistoryProvider = new WatchlistHistoryProvider()
  ) {
    const saved = owner.context.globalState.get(KEY, []);
    if (Array.isArray(saved))
      for (const row of saved.slice(0, 300)) {
        if (
          row &&
          typeof row.symbol === 'string' &&
          /^20\d\d-\d\d-\d\d$/.test(row.date) &&
          Number.isFinite(row.at) &&
          row.at <= owner.now().getTime() + 300000 &&
          owner.now().getTime() - row.at < 7 * DAY &&
          validHistory(row.data)
        )
          this.cache.set(row.symbol, { date: row.date, at: row.at, data: row.data });
      }
    this.listeners = [
      owner.tree.onDidChangeVisibility((e) => {
        if (!e.visible) this.cancel();
        else if (!owner.hidden) owner.emitter.fire(undefined);
      })
    ];
  }
  private configured(symbol: string) {
    return (
      this.owner.config.symbols.includes(symbol) ||
      this.owner.overseas.symbols.hk.includes(symbol) ||
      this.owner.overseas.symbols.us.includes(symbol)
    );
  }
  private current(symbol: string): ListQuote | undefined {
    return this.owner.quotes.get(symbol) || this.owner.overseas.quotes.get(symbol);
  }
  private enabled() {
    return (
      !this.disposed &&
      !(this.owner.hidden ?? this.owner.context.globalState.get('bossKeyHidden', false)) &&
      this.owner.config.enabled &&
      (this.owner.config.trendDisplay === 'text' || this.owner.config.volumeComparison)
    );
  }
  private mayFetch() {
    return this.enabled() && !this.owner.paused && this.owner.tree.visible;
  }
  reconcile() {
    if (!this.mayFetch()) this.cancel();
    for (const symbol of this.cache.keys()) if (!this.configured(symbol)) this.cache.delete(symbol);
    for (const symbol of this.queue.keys()) if (!this.configured(symbol)) this.queue.delete(symbol);
    for (const [symbol, abort] of this.active) if (!this.configured(symbol)) abort.abort();
  }
  private cancel() {
    this.queue.clear();
    for (const abort of this.active.values()) abort.abort();
  }
  private ensure(symbol: string, date: string) {
    if (!this.mayFetch() || !this.configured(symbol)) return;
    if (this.active.has(symbol) || this.queue.get(symbol) === date) return;
    const cached = this.cache.get(symbol),
      attempt = this.attempts.get(symbol),
      now = this.owner.now().getTime();
    if (cached?.date === date && now - cached.at < 7 * DAY) return;
    if (attempt?.date === date && attempt.until > now) return;
    this.queue.set(symbol, date);
    this.pump();
  }
  private pump() {
    if (!this.mayFetch()) return;
    for (const [symbol, date] of this.queue) {
      if (this.active.size >= 2) break;
      if (this.active.has(symbol)) continue;
      this.queue.delete(symbol);
      const abort = new AbortController();
      this.active.set(symbol, abort);
      void this.provider
        .load(symbol, abort.signal)
        .then((data) => {
          if (
            abort.signal.aborted ||
            !this.mayFetch() ||
            !this.configured(symbol) ||
            this.current(symbol)?.date !== date
          )
            return;
          if (!validHistory(data)) throw new Error('历史数据格式异常');
          const metrics = listMetrics(
            this.current(symbol)!,
            data,
            symbol.startsWith('hk') ? 'hk' : symbol.startsWith('us') ? 'us' : 'a'
          );
          if (metrics.missing && /历史/.test(metrics.missing)) throw new Error(metrics.missing);
          this.cache.set(symbol, { date, at: this.owner.now().getTime(), data });
          this.attempts.delete(symbol);
          this.save();
        })
        .catch((error) => {
          if (!abort.signal.aborted && !this.disposed)
            this.attempts.set(symbol, {
              date,
              until: this.owner.now().getTime() + 30 * 60000,
              error: '历史指标暂不可用，稍后自动重试'
            });
        })
        .finally(() => {
          this.active.delete(symbol);
          if (this.mayFetch() && this.configured(symbol))
            this.owner.emitter.fire(
              symbol.startsWith('us') || symbol.startsWith('hk')
                ? this.owner.overseas.element(symbol)
                : this.owner.element(symbol)
            );
          this.pump();
        });
    }
  }
  private save() {
    const rows = [...this.cache]
      .filter(([symbol]) => this.configured(symbol))
      .slice(-300)
      .map(([symbol, value]) => ({ symbol, ...value }));
    this.writing = this.writing
      .catch(() => {})
      .then(() => this.owner.context.globalState.update(KEY, rows))
      .catch(() => {});
  }
  decorate(item: vscode.TreeItem, q: ListQuote | undefined, market: 'a' | 'hk' | 'us', stale: boolean, regular = true) {
    if (!this.enabled() || !q || !this.configured(q.symbol)) return item;
    const tip = item.tooltip;
    if (!(tip instanceof vscode.MarkdownString)) return item;
    if (!regular) {
      tip.appendText('\n列表趋势和七日均量仅比较常规交易时段，盘前/盘后不混算。');
      return item;
    }
    if (q.price === null || q.price <= 0 || q.volume === 0) {
      tip.appendText('\n停牌或暂无有效成交，暂不判断趋势与量能。');
      return item;
    }
    this.ensure(q.symbol, q.date);
    const cached = this.cache.get(q.symbol);
    if (!cached || cached.date !== q.date || this.owner.now().getTime() - cached.at >= 7 * DAY) {
      tip.appendText('\n' + (this.attempts.get(q.symbol)?.error || '列表历史指标等待更新；历史数据不影响当前报价。'));
      return item;
    }
    const m = listMetrics(q, cached.data, market);
    if (m.missing) {
      tip.appendText('\n' + m.missing);
      return item;
    }
    const labels: string[] = [];
    if (this.owner.config.trendDisplay === 'text') {
      if (m.trend) {
        labels.push(m.trend.label);
        tip.appendText(
          `\n日线趋势：${m.trend.label}。MA5 ${m.trend.ma5.toFixed(3)}，MA10 ${m.trend.ma10.toFixed(3)}。价格>MA5>MA10且MA5上行为偏强；反向为偏弱，其余为整理。盘中均线随当前价格变化，不预测涨跌。`
        );
      } else tip.appendText('\n日线趋势：完整历史不足10个交易日，暂不判断。');
    }
    if (this.owner.config.volumeComparison) {
      if (m.ratio != null && m.label) labels.push(`${m.estimated ? '预估' : ''}${m.label} ${m.ratio.toFixed(2)}×`);
      else if (m.actualRatio != null) labels.push(`累计 ${m.actualRatio.toFixed(2)}×均量`);
      else labels.push('量能 —');
      const amount = (n: number | null | undefined) =>
        n == null ? '—' : (n >= 10000 ? `${(n / 10000).toFixed(2)}万` : n.toFixed(0)) + cached.data.unit;
      tip.appendText(
        `\n当日累计成交量：${amount(q.volume)}；前7个完整交易日均量：${amount(m.average)}。${m.actualRatio == null ? '历史不足7日、均量为零或报价缺少成交量，暂不判断。' : `实际累计 / 七日均量：${m.actualRatio.toFixed(2)}倍。`}`
      );
      if (m.ratio != null)
        tip.appendText(
          m.estimated
            ? `\n盘中预估：按已交易${m.progress.elapsed}/${m.progress.total}分钟折算；不是历史同刻量比，开收盘集中成交及半日市会影响估算。`
            : '\n收盘按实际全天成交量比较。'
        );
      else if (m.actualRatio != null)
        tip.appendText(
          market === 'us'
            ? '\n美股常规盘中只显示累计比例，避免提前收盘日误估。'
            : '\n开盘不足15分钟，暂不判断放量或缩量。'
        );
      tip.appendText('\n规则：>1.20倍放量，<0.80倍缩量，其余平量；七日均量不包含当天。');
      if (m.previous?.length === 7) tip.appendText(`比较日期：${m.previous.map((b) => b.date.slice(5)).join('、')}。`);
    }
    if (labels.length)
      item.description = [item.description, ...labels, ...(stale ? ['历史行情'] : [])].filter(Boolean).join(' · ');
    tip.appendText(
      `\n指标对应报价日：${q.date}；历史来源：${cached.data.source}，获取于 ${new Date(cached.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京）。`
    );
    if (stale) tip.appendText('\n当前报价为缓存/历史数据，以上指标也不是实时判断。');
    return item;
  }
  dispose() {
    this.disposed = true;
    this.cancel();
    for (const listener of this.listeners) listener.dispose();
  }
}
