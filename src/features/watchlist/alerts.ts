import * as vscode from 'vscode';
import { stockSession, timeToMinute } from '../turnover/market';
import { localClock, parseOverseasQuotes } from './overseas/controller';
const KEY = 'stockAlertDays';
class StockAlerts {
  declare context: any;
  declare stocks: any;
  declare now: () => Date;
  declare last: number;
  declare sent: any;
  declare write: Promise<void>;
  declare listener: vscode.Disposable;
  declare timer: NodeJS.Timeout | undefined;
  declare abort: AbortController | null | undefined;
  declare inflight: any;
  declare hidden: any;
  declare disposed: boolean | undefined;

  constructor(context, stocks, { now = () => new Date() } = {}) {
    this.context = context;
    this.stocks = stocks;
    this.now = now;
    this.last = -Infinity;
    const saved = context.globalState.get(KEY, {});
    this.sent = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
    this.write = Promise.resolve();
    this.listener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aShareTurnover.stockAlerts') || e.affectsConfiguration('aShareTurnover.stocks')) {
        this.abort?.abort();
        this.last = -Infinity;
      }
    });
  }
  mode() {
    return vscode.workspace.getConfiguration('aShareTurnover').get('stockAlerts.mode', 'whenVisible');
  }
  allowed() {
    const mode = this.mode();
    return (
      !this.disposed &&
      this.stocks.config.enabled &&
      !this.stocks.paused &&
      (mode === 'always' || (mode === 'whenVisible' && !this.hidden))
    );
  }
  clock(market) {
    return market === 'a' ? stockSession(this.now(), this.stocks.config.closedDates) : localClock(this.now(), market);
  }
  fresh(q, market) {
    const clock = this.clock(market);
    if (!clock.polling || q.date !== clock.date || !/^\d{14}$/.test(q.timestamp || '') || !Number.isFinite(q.percent))
      return false;
    try {
      const lag = clock.minute - timeToMinute(q.timestamp.slice(8, 12));
      return lag >= 0 && lag <= 2;
    } catch {
      return false;
    }
  }
  check(quotes, market) {
    if (!this.allowed()) return;
    const symbols = market === 'a' ? this.stocks.config.symbols : this.stocks.overseas.symbols[market];
    const alerts: string[] = [];
    for (const q of quotes) {
      if (!symbols.includes(q.symbol) || !this.fresh(q, market) || Math.abs(q.percent) <= 7) continue;
      const key = `${q.symbol}:${q.percent > 0 ? 'up' : 'down'}`;
      if (this.sent[key] === q.date) continue;
      this.sent[key] = q.date;
      alerts.push(`${q.name}（${q.symbol}）${q.percent > 0 ? '上涨' : '下跌'} ${Math.abs(q.percent).toFixed(2)}%`);
    }
    if (!alerts.length) return;
    const active = new Set([
      ...this.stocks.config.symbols,
      ...this.stocks.overseas.symbols.hk,
      ...this.stocks.overseas.symbols.us
    ]);
    this.sent = Object.fromEntries(Object.entries(this.sent).filter(([key]) => active.has(key.split(':')[0])));
    const saved = { ...this.sent };
    this.write = this.write.catch(() => {}).then(() => this.context.globalState.update(KEY, saved));
    const text = `自选股波动提醒：${alerts.slice(0, 5).join('；')}${alerts.length > 5 ? `；另有 ${alerts.length - 5} 只超过阈值` : ''}。`;
    void Promise.resolve(vscode.window.showWarningMessage(text)).catch(() => {});
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 1000);
  }
  async tick() {
    if (!this.allowed()) return;
    if (!this.hidden) {
      this.check(
        [...this.stocks.quotes.values()].filter((q) => !this.stocks.stale(q.symbol)),
        'a'
      );
      for (const market of ['hk', 'us'])
        this.check(
          [...this.stocks.overseas.quotes.values()].filter(
            (q) => q.symbol.startsWith(market) && !this.stocks.overseas.stale(q.symbol)
          ),
          market
        );
      return;
    }
    // "Always" explicitly opts into monitoring even while the rest of the UI is hidden.
    if (this.inflight || this.now().getTime() - this.last < 10000) return;
    this.last = this.now().getTime();
    const abort = (this.abort = new AbortController());
    this.inflight = (async () => {
      for (const market of ['a', 'hk', 'us']) {
        if (abort.signal.aborted || !this.allowed()) return;
        const symbols = market === 'a' ? this.stocks.config.symbols : this.stocks.overseas.symbols[market];
        if (!symbols.length || !this.clock(market).polling) continue;
        try {
          for (let i = 0; i < symbols.length; i += 50) {
            const batch = symbols.slice(i, i + 50);
            const result =
              market === 'a'
                ? await this.stocks.provider.load(batch, abort.signal)
                : parseOverseasQuotes(
                    await this.stocks.overseas.request(`https://qt.gtimg.cn/q=${batch.join(',')}`, abort.signal),
                    market,
                    batch
                  );
            if (abort.signal.aborted || !this.allowed()) return;
            this.check(
              [...result.quotes.values()].filter((q) => !result.errors.has(q.symbol)),
              market
            );
          }
        } catch {
          /* A failed request must not generate a price alert. */
        }
      }
    })().finally(() => {
      this.inflight = null;
      this.abort = null;
    });
    return this.inflight;
  }
  setHidden(hidden) {
    this.hidden = hidden;
    this.abort?.abort();
    this.last = -Infinity;
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.abort?.abort();
    this.listener.dispose();
  }
}
export { StockAlerts };
