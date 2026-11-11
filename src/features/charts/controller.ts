import { MINUTE_MODES, MODES, INDICATORS, isWebMode, availableMode, escapeHtml, chartHtml } from './view';
import * as vscode from 'vscode';
import * as privateUI from '../../core/ui/privacy';
import { randomBytes } from 'node:crypto';
import { normalizeSymbol, INDEX_SYMBOL, StockProvider, dailyExtremes } from '../watchlist/quotes';
import { POLL_MS, session, normalizeDate, timeToMinute } from '../turnover/market';
import { ChartProvider, eastmoneyUrl, eastmoneyChartUrl, supportsChips } from './data';
import { prependHistory, retainHistory, supportsHistory, MAX_HISTORY_BARS } from './history';
import type { StockQuote } from '../../shared/types';

interface ChartPanel {
  symbol: string;
  panel: vscode.WebviewPanel;
  mode: string;
  token: string;
  ready: boolean;
  visible: boolean;
  generation: number;
  lastAttempt: number;
  abort: AbortController | null;
  inflight: Promise<void> | null;
  data: Awaited<ReturnType<ChartProvider['load']>> | null;
  lastNativeMode?: string;
  listeners?: vscode.Disposable[];
}
class ChartController {
  declare context: any;
  declare provider: ChartProvider;
  declare quoteProvider: StockProvider;
  private quoteSnapshot: (symbol: string) => StockQuote | undefined;
  private onOpen: (symbol: string) => void;
  declare now: () => Date;
  declare selected: () => string;
  declare name: (symbol: string) => string | undefined;
  declare panels: Map<any, any>;
  declare cache: Map<any, any>;
  declare disposed: boolean;
  declare indicator: any;
  declare timer: NodeJS.Timeout;
  declare hidden: any;

  constructor(
    context,
    {
      provider = new ChartProvider(),
      quoteProvider = new StockProvider(),
      quoteSnapshot = (_symbol: string): StockQuote | undefined => undefined,
      onOpen = (_symbol: string): void => {},
      now = () => new Date(),
      selected = (): string => INDEX_SYMBOL,
      name = (_symbol: string): string | undefined => undefined
    } = {}
  ) {
    this.context = context;
    this.provider = provider;
    this.quoteProvider = quoteProvider;
    this.quoteSnapshot = quoteSnapshot;
    this.onOpen = onOpen;
    this.now = now;
    this.selected = selected;
    this.name = name;
    this.panels = new Map();
    this.cache = new Map();
    this.disposed = false;
    const savedIndicator = context.globalState.get('chartIndicator', 'macd');
    this.indicator = INDICATORS.includes(savedIndicator) ? savedIndicator : 'macd';
    this.timer = setInterval(() => this.tick(), 1000);
  }
  resolve(element) {
    return normalizeSymbol(typeof element === 'string' ? element : element?.symbol || this.selected());
  }
  async open(element?, mode?: string) {
    if (this.disposed || this.hidden) return;
    let symbol;
    try {
      symbol = this.resolve(element);
    } catch (e) {
      return privateUI.showErrorMessage(e.message);
    }
    const requestedMode = mode && MODES.includes(mode) ? mode : undefined;
    const defaultMode = vscode.workspace.getConfiguration('aShareTurnover').get('charts.defaultMode', 'intraday');
    const existing = this.panels.values().next().value;
    if (existing) {
      const nextMode = availableMode(symbol, requestedMode || existing.mode);
      if (existing.symbol !== symbol) {
        this.cancel(existing);
        this.panels.clear();
        existing.symbol = symbol;
        existing.mode = nextMode;
        existing.data = null;
        existing.ready = false;
        existing.pendingRefresh = false;
        if (!isWebMode(nextMode)) existing.lastNativeMode = nextMode;
        existing.token = randomBytes(24).toString('hex');
        existing.lastAttempt = -Infinity;
        this.panels.set(symbol, existing);
        existing.panel.title = `${this.name(symbol) || symbol} · 行情`;
        existing.panel.webview.html = chartHtml(existing.panel.webview, this.context, symbol, existing.token, nextMode);
      } else if (requestedMode && nextMode !== existing.mode) {
        this.changeMode(existing, nextMode);
      }
      existing.panel.reveal();
      this.onOpen(symbol);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'welove42.aShareTurnover.stockChart',
      `${this.name(symbol) || symbol} · 行情`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews')
        ]
      }
    );
    const state: ChartPanel = {
      symbol,
      panel,
      mode: availableMode(symbol, requestedMode || defaultMode),
      token: randomBytes(24).toString('hex'),
      ready: false,
      visible: panel.visible,
      generation: 0,
      lastAttempt: -Infinity,
      abort: null,
      inflight: null,
      data: null
    };
    state.lastNativeMode = isWebMode(state.mode) ? 'intraday' : state.mode;
    this.panels.set(symbol, state);
    state.listeners = [
      panel.webview.onDidReceiveMessage((message) => this.receive(state, message)),
      panel.onDidDispose(() => this.close(state)),
      panel.onDidChangeViewState(() => {
        if (state.visible === panel.visible) return;
        state.visible = panel.visible;
        if (!panel.visible) this.cancel(state);
        else if (state.ready && !isWebMode(state.mode)) void this.refresh(state);
      })
    ];
    panel.webview.html = chartHtml(panel.webview, this.context, symbol, state.token, state.mode);
    this.onOpen(symbol);
  }
  send(state, message) {
    if (!this.disposed && this.panels.get(state.symbol) === state)
      void Promise.resolve(state.panel.webview.postMessage({ ...message, token: state.token })).catch(() => {});
  }
  visibleState() {
    // The title toolbar can be clicked in a visible but unfocused editor group.
    return this.disposed ? undefined : [...this.panels.values()].find((state) => state.panel.visible);
  }
  changeMode(state, mode) {
    const next = availableMode(state.symbol, mode);
    if (!isWebMode(next)) state.lastNativeMode = next;
    if (state.mode !== next) {
      this.cancel(state);
      state.mode = next;
      state.data = null;
      state.lastAttempt = -Infinity;
    }
    if (state.ready) this.send(state, { type: 'select-mode', mode: next });
  }
  async chooseMode() {
    const state = this.visibleState();
    if (!state) return;
    const token = state.token;
    const items = [
      ...(isWebMode(state.mode)
        ? [
            {
              mode: state.lastNativeMode,
              label: '返回内置图表',
              detail: '恢复上次内置周期；分时、分钟K、日/周/月K均在图表内切换。'
            }
          ]
        : []),
      {
        mode: 'eastmoney',
        label: '常规图表（东方财富）',
        detail: '网页支持更多周期；遇验证码可切换内置图表，或用右上角浏览器按钮打开。'
      },
      {
        mode: 'chips',
        label: '筹码盘口（东方财富）',
        detail: '买卖五档及“日K → 筹码分布”；遇验证码建议在浏览器打开并手动完成验证。'
      }
    ]
      .filter((item) => item.mode !== 'chips' || supportsChips(state.symbol))
      .map((item) => ({ ...item, description: item.mode === state.mode ? '当前图表' : undefined }));
    const picked = await privateUI.showQuickPick(items, {
      title: `${this.name(state.symbol) || state.symbol} · 切换图表来源`,
      placeHolder: isWebMode(state.mode)
        ? '返回内置图表或选择网页模式'
        : supportsChips(state.symbol)
          ? '周期请在图表内切换，这里选择网页图表'
          : '周期请在图表内切换；当前品种仅支持东方财富常规图表',
      matchOnDetail: true
    });
    // A picker opened for the previous stock must not change a newly opened stock.
    if (
      picked &&
      items.some((item) => item.mode === picked.mode) &&
      this.visibleState() === state &&
      state.token === token
    )
      this.changeMode(state, picked.mode);
  }
  async chooseIndicator() {
    const state = this.visibleState();
    if (!state) return;
    const token = state.token;
    const picked = await privateUI.showQuickPick(
      [
        { indicator: 'macd', label: 'MACD (12,26,9)', detail: 'DIF、DEA与红绿柱；默认显示。' },
        { indicator: 'kdj', label: 'KDJ (9,3,3)', detail: 'K、D、J三条曲线；分时使用分钟采样价格计算。' },
        { indicator: 'rsi', label: 'RSI (6,12,24)', detail: '6、12、24周期相对强弱曲线。' },
        { indicator: 'none', label: '隐藏技术指标', detail: '仅保留主图与成交量。' }
      ].map((item) => ({ ...item, description: item.indicator === this.indicator ? '当前指标' : undefined })),
      {
        title: '切换内置副图指标',
        placeHolder: isWebMode(state.mode)
          ? '选择后切到内置分时图；网页指标由网站自身控制'
          : '指标按当前图表周期计算，切换不请求网络'
      }
    );
    if (!picked || !INDICATORS.includes(picked.indicator) || this.visibleState() !== state || state.token !== token)
      return;
    this.selectIndicator(state, picked.indicator);
    if (isWebMode(state.mode)) this.changeMode(state, 'intraday');
  }
  selectIndicator(state, indicator) {
    if (!INDICATORS.includes(indicator) || indicator === this.indicator) return;
    this.indicator = indicator;
    void Promise.resolve(this.context.globalState.update('chartIndicator', this.indicator)).catch(() => {});
    if (state.ready) this.send(state, { type: 'select-indicator', indicator: this.indicator });
  }
  restoreSyncedPreferences() {
    const value = this.context.globalState.get('chartIndicator', 'macd');
    const indicator = INDICATORS.includes(value) ? value : 'macd';
    if (this.disposed || this.indicator === indicator) return;
    this.indicator = indicator;
    if (!this.hidden)
      for (const state of this.panels.values())
        if (state.ready && !isWebMode(state.mode)) this.send(state, { type: 'select-indicator', indicator });
  }
  refreshActive() {
    const state = this.visibleState();
    if (!state) return;
    if (!state.ready) {
      state.pendingRefresh = true;
      return;
    }
    if (isWebMode(state.mode)) this.send(state, { type: 'refresh', mode: state.mode });
    else return this.refresh(state, true);
  }
  openActiveExternal() {
    const state = this.visibleState();
    if (state) return this.openExternal(state.symbol, state.mode);
  }
  receive(state, message) {
    if (this.disposed || this.panels.get(state.symbol) !== state || !message || message.token !== state.token) return;
    if (message.action === 'external') return this.openExternal(state.symbol, state.mode);
    if (message.action === 'history' && state.ready && supportsHistory(state.mode))
      return this.loadOlder(state, message.all === true);
    if (message.action === 'indicator' && state.ready && !isWebMode(state.mode)) {
      this.selectIndicator(state, message.indicator);
      return;
    }
    if (
      message.action === 'period' &&
      state.ready &&
      !isWebMode(state.mode) &&
      ['intraday', 'intraday5', ...MINUTE_MODES, 'daily', 'weekly', 'monthly'].includes(message.mode)
    ) {
      if (message.mode !== state.mode) this.changeMode(state, message.mode);
      return;
    }
    if (message.action === 'ready') {
      state.ready = true;
      this.send(state, { type: 'select-indicator', indicator: this.indicator });
      this.send(state, { type: 'select-mode', mode: state.mode });
      if (state.pendingRefresh) {
        state.pendingRefresh = false;
        if (isWebMode(state.mode)) this.send(state, { type: 'refresh', mode: state.mode });
      }
    } else if (message.action === 'mode-ready' && state.ready && message.mode === state.mode) {
      if (!isWebMode(state.mode)) return this.refresh(state);
    } else if (message.action === 'refresh' && state.ready && !isWebMode(state.mode)) return this.refresh(state, true);
  }
  cancel(state) {
    if (state.historyInflight)
      this.send(state, {
        type: 'history-state',
        mode: state.mode,
        busy: false,
        message: '历史加载已暂停，已加载走势保留。'
      });
    state.generation++;
    state.abort?.abort();
    state.abort = null;
    state.inflight = null;
    state.historyAbort?.abort();
    state.historyAbort = null;
    state.historyInflight = null;
  }
  loadOlder(state, all = false) {
    if (this.disposed || this.hidden || !state.ready || !state.panel.visible || !supportsHistory(state.mode))
      return Promise.resolve();
    if (state.historyInflight) return state.historyInflight;
    const generation = state.generation,
      mode = state.mode,
      symbol = state.symbol;
    const abort = (state.historyAbort = new AbortController());
    const active = () => !this.disposed && !abort.signal.aborted && state.generation === generation;
    const status = (busy, message = '') => this.send(state, { type: 'history-state', mode, busy, message });
    status(true, '正在加载更早走势…');
    state.historyInflight = (async () => {
      try {
        await Promise.resolve();
        if (state.inflight) await state.inflight;
        if (!active()) return;
        if (!state.data?.bars?.length || typeof this.provider.loadEarlier !== 'function')
          throw new Error('请先加载当前K线后重试');
        let pages = 0;
        while (!state.data.historyComplete && pages < 30) {
          if (state.data.bars.length >= MAX_HISTORY_BARS) throw new Error('历史记录达到容量上限');
          const older = await this.provider.loadEarlier(
            symbol,
            mode,
            state.data.bars[0].time,
            abort.signal,
            state.data.sourceId
          );
          if (!active()) return;
          state.data = prependHistory(state.data, older);
          this.cache.set(`${symbol}:${mode}`, { data: state.data, at: state.lastAttempt });
          this.send(state, { type: 'data', data: state.data });
          status(
            true,
            `已加载 ${state.data.bars[0].time} 至 ${state.data.bars.at(-1).time}，共 ${state.data.bars.length} 根…`
          );
          pages++;
          if (!all) break;
        }
        if (all && !state.data.historyComplete) throw new Error('本次历史加载已暂停，可再次点击“全部历史”继续');
        // Supplement turnover once after prices are visible, not on each historical page.
        if (
          state.data.turnoverApplicable &&
          !state.data.sourceId &&
          typeof this.provider.loadHistoricalTurnover === 'function'
        ) {
          try {
            const rates = await this.provider.loadHistoricalTurnover(symbol, mode, abort.signal, {
              bars: state.data.bars
            });
            if (!active()) return;
            state.data = {
              ...state.data,
              bars: state.data.bars.map((bar) => ({
                ...bar,
                historicalTurnover: rates.get(bar.time) ?? bar.historicalTurnover ?? null
              })),
              historicalStatus: rates.stale ? 'stale' : 'ready',
              historicalSource: rates.source
            };
            this.cache.set(`${symbol}:${mode}`, { data: state.data, at: state.lastAttempt });
            this.send(state, { type: 'data', data: state.data });
          } catch {
            /* Missing turnover must not discard valid price history. */
          }
        }
        if (active()) status(false, state.data.historyComplete ? `已到数据源最早记录：${state.data.bars[0].time}` : '');
      } catch (error) {
        if (active()) status(false, `${error.message || '历史加载失败'}；已加载走势保留，可重试。`);
      } finally {
        if (state.generation === generation) {
          state.historyInflight = null;
          state.historyAbort = null;
        }
      }
    })();
    return state.historyInflight;
  }
  refresh(state, force = false) {
    if (this.disposed || !state.ready || !state.panel.visible || isWebMode(state.mode)) return Promise.resolve();
    if (state.inflight) return state.inflight;
    if (state.historyInflight) return state.historyInflight;
    const key = `${state.symbol}:${state.mode}`,
      now = this.now().getTime(),
      cached = this.cache.get(key);
    if (!force && cached && now >= cached.at && now - cached.at < POLL_MS) {
      state.data = cached.data;
      state.lastAttempt = cached.at;
      this.send(state, { type: 'data', data: cached.data });
      return Promise.resolve();
    }
    // Repeated toolbar clicks must not create a request burst.
    if (force && now - state.lastAttempt < 2000) return Promise.resolve();
    const generation = state.generation,
      mode = state.mode,
      abort = (state.abort = new AbortController());
    state.lastAttempt = this.now().getTime();
    this.send(state, { type: 'loading', mode, preserve: Boolean(state.data) });
    state.inflight = (async () => {
      try {
        const fresh = await this.provider.load(state.symbol, mode, abort.signal);
        if (this.disposed || abort.signal.aborted || state.generation !== generation) return;
        // Reset is a one-shot view event; do not cache it or repeat it during subsequent history/enrichment updates.
        const { historyReset, ...data } = retainHistory(state.data || this.cache.get(key)?.data, fresh);
        const needsHistory =
          data.turnoverApplicable &&
          mode !== 'intraday' &&
          !('sourceId' in data) &&
          data.bars.some((bar) => bar.historicalTurnover == null) &&
          typeof this.provider.loadHistoricalTurnover === 'function';
        const needsEtf = data.etfEligible && !data.etf;
        state.data = {
          ...data,
          ...(needsHistory ? { historicalStatus: 'loading' } : {}),
          ...(data.etfEligible ? { etfStatus: needsEtf ? 'loading' : 'ready' } : {})
        };
        this.cache.delete(key);
        this.cache.set(key, { data: state.data, at: state.lastAttempt });
        if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
        if (data.name) state.panel.title = `${data.name} · 行情`;
        this.send(state, { type: 'data', data: historyReset ? { ...state.data, historyReset: true } : state.data });
        const enrich = (patch) => {
          if (this.disposed || abort.signal.aborted || state.generation !== generation) return;
          const enriched = { ...state.data, ...patch };
          state.data = enriched;
          this.cache.set(key, { data: enriched, at: state.lastAttempt });
          this.send(state, { type: 'data', data: enriched });
        };
        const tasks: Promise<void>[] = [];
        // Quote and historical enrichment never delay the first chart render.
        const needsExtremes = Object.hasOwn(data, 'dailyHigh') && (data.dailyHigh === null || data.dailyLow === null);
        const needsLive = supportsHistory(mode) && 'sourceId' in data;
        if ((data.turnoverApplicable && data.turnoverRate === null) || needsExtremes || needsEtf || needsLive)
          tasks.push(
            (async () => {
              try {
                const snapshot = this.quoteSnapshot(state.symbol);
                const result = snapshot
                  ? { quotes: new Map([[state.symbol, snapshot]]) }
                  : await this.quoteProvider.load([state.symbol], abort.signal);
                if (this.disposed || abort.signal.aborted || state.generation !== generation) return;
                const quote = result.quotes.get(state.symbol);
                if (needsEtf) {
                  if (quote) enrich({ etf: quote.etf, etfStatus: quote.etf ? 'ready' : 'unavailable' });
                  else enrich({ etfStatus: 'error', etfError: 'ETF 参考数据获取失败，可刷新重试。' });
                }
                if (!quote || !/^\d{14}$/.test(quote.timestamp || '')) return;
                try {
                  normalizeDate(quote.timestamp.slice(0, 8));
                  timeToMinute(quote.timestamp.slice(8, 12));
                  if (Number(quote.timestamp.slice(12, 14)) > 59) return;
                } catch {
                  return;
                }
                const patch = {};
                if (
                  data.turnoverApplicable &&
                  data.turnoverRate === null &&
                  Number.isFinite(quote.turnoverRate) &&
                  quote.turnoverRate !== null &&
                  quote.turnoverRate >= 0
                )
                  Object.assign(patch, { turnoverRate: quote.turnoverRate, turnoverTimestamp: quote.timestamp });
                if (needsExtremes) {
                  const range = dailyExtremes(quote.high, quote.low);
                  if (
                    (range.dailyHigh !== null || range.dailyLow !== null) &&
                    (!data.dailyQuoteTimestamp || quote.timestamp >= data.dailyQuoteTimestamp)
                  )
                    Object.assign(patch, range, { dailyQuoteTimestamp: quote.timestamp });
                }
                if (Object.keys(patch).length) enrich(patch);
                if (needsLive && typeof this.provider.withQuote === 'function') {
                  const updated = await this.provider.withQuote(state.data, quote, abort.signal);
                  if (updated !== state.data) enrich(updated);
                }
              } catch {
                if (needsEtf) enrich({ etfStatus: 'error', etfError: 'ETF 参考数据获取失败，可刷新重试。' });
                /* A quote failure must not prevent the chart from rendering. */
              }
            })()
          );
        if (needsHistory)
          tasks.push(
            (async () => {
              try {
                const rates = await this.provider.loadHistoricalTurnover(data.symbol, mode, abort.signal, {
                  bars: data.bars,
                  force
                });
                if (this.disposed || abort.signal.aborted || state.generation !== generation) return;
                enrich({
                  historicalStatus: rates.stale ? 'stale' : 'ready',
                  historicalSource: rates.source || '行情源',
                  historicalFetchedAt: rates.fetchedAt
                    ? new Date(rates.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
                    : '',
                  bars: state.data.bars.map((bar) => ({
                    ...bar,
                    historicalTurnover:
                      rates.get(mode === 'intraday5' ? bar.date : bar.time) ?? bar.historicalTurnover ?? null
                  }))
                });
              } catch (error) {
                enrich({ historicalStatus: 'error', historicalError: error.message || '历史换手率获取失败' });
              }
            })()
          );
        await Promise.all(tasks);
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted && state.generation === generation)
          this.send(state, {
            type: 'error',
            mode,
            message: error.message || '图表获取失败',
            preserve: Boolean(state.data)
          });
      } finally {
        if (state.generation === generation) {
          state.inflight = null;
          state.abort = null;
        }
      }
    })();
    return state.inflight;
  }
  tick() {
    if (this.disposed) return;
    const extra = vscode.workspace.getConfiguration('aShareTurnover').get('additionalClosedDates', []);
    if (!session(this.now(), extra).polling) return;
    for (const state of this.panels.values())
      if (
        state.ready &&
        !isWebMode(state.mode) &&
        state.panel.visible &&
        !state.inflight &&
        this.now().getTime() - state.lastAttempt >= POLL_MS
      )
        void this.refresh(state);
  }
  async openExternal(element, mode?: string) {
    try {
      const symbol = this.resolve(element);
      return await vscode.env.openExternal(
        vscode.Uri.parse(isWebMode(mode) ? eastmoneyChartUrl(symbol, mode) : eastmoneyUrl(symbol))
      );
    } catch (e) {
      return privateUI.showErrorMessage(e.message);
    }
  }
  getState(symbol) {
    const state = this.panels.get(symbol);
    return state
      ? {
          symbol,
          mode: state.mode,
          indicator: this.indicator,
          ready: Boolean(state.ready),
          date: state.data?.date,
          bars: state.data?.bars?.length || 0
        }
      : undefined;
  }
  close(state) {
    this.cancel(state);
    for (const listener of state.listeners) listener.dispose();
    if (this.panels.get(state.symbol) === state) this.panels.delete(state.symbol);
  }
  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) for (const state of [...this.panels.values()]) state.panel.dispose();
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.cache.clear();
    for (const state of [...this.panels.values()]) {
      this.close(state);
      state.panel.dispose();
    }
  }
}
export { ChartController, chartHtml };
