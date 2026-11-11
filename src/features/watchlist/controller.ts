import * as vscode from 'vscode';
import * as privateUI from '../../core/ui/privacy';
import { POLL_MS, PHASE_LABELS, stockSession, timeToMinute, stockTradingMinute } from '../turnover/market';
import {
  INDEX_SYMBOL,
  normalizeSymbol,
  normalizeSymbols,
  isQuote,
  signed,
  percentText,
  orderedSymbols,
  StockProvider
} from './quotes';
import { quoteClock } from '../turnover/view';
import { StockSearch } from './search';
import { StockSettings } from './settings';
import { StockGroups, normalizeGroups, UNGROUPED } from './groups';
import { trendIcon } from './trend-icon';
import { COLOR_KEYS, stockColors, stockStatusColor } from './colors';
import { OverseasWatchlist } from './overseas/controller';
import { normalizeOverseas } from './overseas/symbols';
import { StockActivity } from './activity';
import { StockListInsights } from './insights';
import { WatchlistHistoryProvider } from './insights-data';
interface StockPick extends vscode.QuickPickItem {
  market?: string;
  symbols?: string[];
  empty?: boolean;
}
const WATCHLIST_MIME = 'application/vnd.code.tree.welove42.ashareturnover.watchlist';
const DEBUG_ITEMS = [
  { kind: 'debugPlaceholder', id: 'intro', label: '运行和调试可帮助你发现和修复问题。' },
  { kind: 'debugPlaceholder', id: 'start', label: '运行和调试', icon: 'debug-start' },
  { kind: 'debugPlaceholder', id: 'configure', label: '创建调试配置', icon: 'gear' }
];

class WatchlistController {
  declare context: any;
  declare provider: StockProvider;
  declare now: () => Date;
  declare log: (message: string) => void;
  declare search: StockSearch;
  declare settings: StockSettings;
  declare disposed: boolean;
  declare inflight: any;
  declare abort: AbortController | null;
  declare lastAttempt: number;
  declare generation: number;
  declare quotes: Map<any, any>;
  declare errors: Map<any, any>;
  declare signatures: Map<any, any>;
  declare group: {
    kind: string;
  };
  declare elements: Map<any, any>;
  declare settingsQueue: Promise<void>;
  declare dragIdentity: {};
  declare cached: boolean;
  declare paused: boolean;
  declare emitter: vscode.EventEmitter<any>;
  declare onDidChangeTreeData: vscode.Event<any>;
  declare tree: vscode.TreeView<any>;
  declare status: vscode.StatusBarItem;
  declare statusVisible: boolean;
  declare statusRendered: { text?: string; tooltip?: string; color?: string };
  declare config: {
    enabled: boolean;
    symbols: any[];
    selected: string;
    error: string;
    groups: {
      id: any;
      name: string;
      symbols: any;
    }[];
    sortBy: any;
    trendDisplay: string;
    volumeComparison: boolean;
    colors: {
      mode: any;
      up: any;
      down: any;
    };
    closedDates: string[];
  };
  declare grouping: StockGroups;
  declare overseas: OverseasWatchlist;
  declare phaseKey: string;
  declare listener: vscode.Disposable;
  declare timer: NodeJS.Timeout | undefined;
  declare writingSettings: any;
  declare activePicker: vscode.QuickPick<StockPick> | null | undefined;
  declare hidden: any;
  readonly activity: StockActivity;
  readonly insights: StockListInsights;

  constructor(
    context,
    {
      provider = new StockProvider(),
      search = new StockSearch(),
      insightsProvider = new WatchlistHistoryProvider(),
      now = () => new Date(),
      log = (_message: string) => {}
    } = {}
  ) {
    this.context = context;
    this.provider = provider;
    this.now = now;
    this.log = log;
    this.search = search;
    this.settings = new StockSettings(context, log);
    this.disposed = false;
    this.inflight = null;
    this.abort = null;
    this.lastAttempt = -Infinity;
    this.generation = 0;
    this.quotes = new Map();
    this.errors = new Map();
    this.signatures = new Map();
    this.group = { kind: 'group' };
    this.elements = new Map();
    this.settingsQueue = Promise.resolve();
    this.dragIdentity = {};
    this.cached = true;
    this.paused = Boolean(context.globalState.get('stocksPaused', false));
    const stored = context.globalState.get('stockQuotes', []);
    if (Array.isArray(stored)) for (const q of stored) if (isQuote(q)) this.quotes.set(q.symbol, q);
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView('welove42.aShareTurnover.marketWatch', {
      treeDataProvider: this,
      showCollapseAll: true,
      canSelectMany: true,
      dragAndDropController: {
        dragMimeTypes: [WATCHLIST_MIME],
        dropMimeTypes: [WATCHLIST_MIME],
        handleDrag: (source, transfer, token) => this.handleDrag(source, transfer, token),
        handleDrop: (target, transfer, token) => this.handleDrop(target, transfer, token)
      }
    });
    this.status = vscode.window.createStatusBarItem(
      'aShareTurnover.selectedStock',
      vscode.StatusBarAlignment.Right,
      99
    );
    this.status.name = '上证指数 / 自选股';
    this.status.command = 'welove42.aShareTurnover.stocks.selectStatus';
    this.statusVisible = false;
    this.statusRendered = {};
    this.config = this.readConfig();
    this.grouping = new StockGroups(this);
    this.overseas = new OverseasWatchlist(this);
    this.activity = new StockActivity(this);
    this.insights = new StockListInsights(this, insightsProvider);
    this.phaseKey = '';
    this.listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (this.writingSettings) return;
      if (
        !event.affectsConfiguration('aShareTurnover.stocks') &&
        !event.affectsConfiguration('aShareTurnover.additionalClosedDates')
      )
        return;
      const previous = this.config;
      this.config = this.readConfig();
      const overseasChanged = this.syncOverseas();
      if (previous.enabled !== this.config.enabled) {
        if (!this.config.enabled) for (const abort of Object.values(this.overseas.abort)) abort?.abort();
        else if (!this.paused)
          void Promise.all(Object.values(this.overseas.inflight)).then(() => this.overseas.refreshAll());
      }
      const symbolsChanged = JSON.stringify(previous.symbols) !== JSON.stringify(this.config.symbols);
      const structural =
        overseasChanged ||
        previous.enabled !== this.config.enabled ||
        symbolsChanged ||
        previous.sortBy !== this.config.sortBy ||
        previous.trendDisplay !== this.config.trendDisplay ||
        previous.volumeComparison !== this.config.volumeComparison ||
        JSON.stringify(previous.groups) !== JSON.stringify(this.config.groups) ||
        JSON.stringify(previous.colors) !== JSON.stringify(this.config.colors);
      const reload =
        previous.enabled !== this.config.enabled || symbolsChanged || previous.selected !== this.config.selected;
      if (reload) {
        this.generation++;
        this.abort?.abort();
      }
      this.publish(structural);
      if (reload && this.config.enabled && !this.paused) {
        void (this.inflight || Promise.resolve()).then(() => {
          if (!this.disposed && this.config.enabled && !this.paused) return this.refresh();
        });
      }
    });
  }
  readConfig() {
    const c = vscode.workspace.getConfiguration('aShareTurnover');
    let symbols: string[] = [],
      error = '',
      selected = INDEX_SYMBOL;
    try {
      symbols = normalizeSymbols(this.settings.get('stocks.symbols', []));
    } catch (e) {
      error = e.message;
    }
    try {
      selected = normalizeSymbol(this.settings.get('stocks.statusBarSymbol', INDEX_SYMBOL));
    } catch {
      error ||= '状态栏代码无效，已使用上证指数';
    }
    // A removed watchlist item cannot remain secretly selected in the status bar.
    if (selected !== INDEX_SYMBOL && !symbols.includes(selected)) selected = INDEX_SYMBOL;
    return {
      enabled: c.get('stocks.enabled', true),
      symbols,
      selected,
      error,
      groups: normalizeGroups(this.settings.get('stocks.groups', []), symbols),
      sortBy: this.settings.get('stocks.sortBy', 'manual'),
      trendDisplay: this.settings.get('stocks.trendDisplay', 'text'),
      volumeComparison: this.settings.get('stocks.volumeComparison', true),
      colors: stockColors((key, fallback) => this.settings.get(key, fallback)),
      closedDates: c.get<string[]>('additionalClosedDates', [])
    };
  }
  start() {
    const c = this.clock();
    this.phaseKey = c.date + c.phase;
    this.publish(true);
    this.timer = setInterval(() => void this.tick(), 1000);
    if (this.config.enabled && !this.paused) void this.refresh();
    if (this.config.enabled && !this.paused) void this.overseas.refreshAll();
  }
  syncOverseas() {
    const previous = JSON.stringify([this.overseas.symbols, this.overseas.stockGroups]);
    const membership = () => JSON.stringify(['hk', 'us'].map((m) => [...this.overseas.symbols[m]].sort()));
    const previousMembership = membership();
    this.overseas.read();
    if (previousMembership !== membership()) {
      const running = Object.values(this.overseas.inflight);
      this.overseas.changed();
      void Promise.all(running).then(() => {
        if (!this.disposed && !this.paused && this.config.enabled) return this.overseas.refreshAll();
      });
    }
    return previous !== JSON.stringify([this.overseas.symbols, this.overseas.stockGroups]);
  }
  groupingFor(market = 'a') {
    return market === 'a' ? this.grouping : this.overseas.grouping[market];
  }
  async groupCommand(operation, element) {
    if (this.hidden || this.disposed) return;
    let market = element ? element.market || 'a' : undefined;
    if (!market)
      market = (
        await privateUI.showQuickPick(
          [
            { label: 'A 股', market: 'a' },
            { label: '港股', market: 'hk' },
            { label: '美股', market: 'us' }
          ],
          { title: '选择自选市场' }
        )
      )?.market;
    const grouping = market && this.groupingFor(market);
    if (!grouping || this.hidden || this.disposed) return;
    if (operation === 'create') return grouping.create();
    if (operation === 'add') return grouping.add(element?.kind === 'stockGroup' ? element.id : UNGROUPED);
    if (['rename', 'remove', 'move'].includes(operation)) return grouping[operation](element);
  }
  clock() {
    return stockSession(this.now(), this.config.closedDates);
  }
  tick() {
    if (this.disposed || this.hidden) return;
    const clock = this.clock(),
      key = clock.date + clock.phase;
    const boundary = key !== this.phaseKey;
    this.phaseKey = key;
    this.publish(false);
    if (this.config.enabled) this.overseas.tick(!this.paused);
    if (
      this.config.enabled &&
      !this.paused &&
      !this.inflight &&
      ((clock.polling && this.now().getTime() - this.lastAttempt >= POLL_MS) || boundary)
    )
      return this.refresh();
  }
  stale(symbol) {
    const q = this.quotes.get(symbol),
      clock = this.clock();
    if (!q || this.cached || this.errors.has(symbol) || q.date !== clock.date) return true;
    return (
      clock.polling && stockTradingMinute(clock.minute) - stockTradingMinute(timeToMinute(q.timestamp.slice(8, 12))) > 2
    );
  }
  /** 盘前清空展示，不修改真实报价和缓存；有当天集合竞价行情后恢复。 */
  dailyReset(symbol: string) {
    if (symbol === INDEX_SYMBOL || !this.config.symbols.includes(symbol)) return false;
    const clock = this.clock(),
      q = this.quotes.get(symbol);
    return (
      clock.phase !== 'closed' &&
      clock.minute >= 540 &&
      (!q || q.date !== clock.date || q.timestamp.slice(8, 12) < '0915')
    );
  }
  resetPrice(symbol: string) {
    const q = this.quotes.get(symbol),
      clock = this.clock();
    if (!q) return '—';
    if (q.date === clock.date && q.previousClose != null && q.previousClose > 0) {
      const decimals = q.priceText.split('.')[1]?.length ?? 2;
      return q.previousClose.toFixed(Math.min(decimals, 4));
    }
    // 仅使用上一交易日收盘后的报价，避免将断线时的旧盘中价当成昨收。
    const date = new Date(clock.date + 'T04:00:00Z');
    for (let i = 0; i < 30; i++) {
      date.setUTCDate(date.getUTCDate() - 1);
      const previous = stockSession(date, this.config.closedDates);
      if (previous.phase === 'closed') continue;
      return q.date === previous.date && q.timestamp.slice(8, 12) >= '1500' && q.price != null && q.price > 0
        ? q.priceText
        : '—';
    }
    return '—';
  }
  displayQuotes() {
    return new Map(
      [...this.quotes].map(([symbol, quote]) => [symbol, this.dailyReset(symbol) ? { ...quote, percent: 0 } : quote])
    );
  }
  getChildren(element) {
    if (this.hidden) return element ? [] : DEBUG_ITEMS;
    if (!this.config.enabled) return [];
    if (!element) return [this.group, ...this.overseas.getGroups()];
    if (element.kind === 'overseasGroup') return this.overseas.getChildren(element);
    if (element.kind === 'stockGroup') return this.groupingFor(element.market)?.children(element.id) || [];
    if (element.kind !== 'group') return [];
    if (this.config.groups.length) return this.grouping.buckets().map((g) => this.grouping.element(g.id));
    return orderedSymbols(this.config.symbols, this.displayQuotes(), this.config.sortBy).map((symbol) =>
      this.element(symbol)
    );
  }
  element(symbol) {
    if (!this.elements.has(symbol)) this.elements.set(symbol, { kind: 'stock', symbol });
    return this.elements.get(symbol);
  }
  getParent(element) {
    if (element.kind === 'stock')
      return this.config.groups.length ? this.grouping.element(this.grouping.idFor(element.symbol)) : this.group;
    if (element.kind === 'stockGroup')
      return !element.market || element.market === 'a' ? this.group : this.overseas.groups[element.market];
    if (element.kind === 'overseasStock') {
      const grouping = this.groupingFor(element.market);
      return grouping.groups.length
        ? grouping.element(grouping.idFor(element.symbol))
        : this.overseas.groups[element.market];
    }
    return undefined;
  }
  getTreeItem(element) {
    if (element.kind === 'debugPlaceholder') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = `debug-placeholder:${element.id}`;
      if (element.icon) item.iconPath = new vscode.ThemeIcon(element.icon);
      return item;
    }
    if (this.hidden) return new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
    if (element.kind === 'overseasGroup' || element.kind === 'overseasStock')
      return this.activity.decorate(this.overseas.getTreeItem(element), element);
    if (element.kind === 'stockGroup')
      return this.activity.decorate(this.groupingFor(element.market).treeItem(element), element);
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(
        `A Stock (${this.config.symbols.length})`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = 'a-share-watchlist';
      item.contextValue = 'aShareRoot';
      item.description = '涨跌幅 · 现价 · 名称';
      item.tooltip = '点击新建分组可分类管理 A 股；拖动个股可排序或移动分组。拖到 A 股标题会移至未分组末尾。';
      return this.activity.decorate(item, element);
    }
    const q = this.quotes.get(element.symbol),
      reset = this.dailyReset(element.symbol),
      stale = reset || this.stale(element.symbol);
    const label = reset
      ? `${percentText(0).padStart(7)}   ${this.resetPrice(element.symbol).padStart(8)}   [${q?.name || element.symbol}]`
      : q
        ? `${percentText(q.percent).padStart(7)}   ${q.priceText.padStart(8)}   [${q.name}]`
        : `—   —   [${element.symbol}]`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `stock:${element.symbol}`;
    item.contextValue = 'aShareStock';
    item.command = {
      command: 'welove42.aShareTurnover.stocks.openChart',
      title: '查看详细行情图表',
      arguments: [element.symbol]
    };
    item.description = reset
      ? '待今日行情'
      : this.errors.has(element.symbol)
        ? '获取失败'
        : stale
          ? q && q.date !== this.clock().date
            ? q.date.slice(5)
            : '缓存'
          : '';
    item.iconPath = reset
      ? trendIcon(this.context.extensionUri, 0, this.config.colors)
      : this.errors.has(element.symbol)
        ? new vscode.ThemeIcon('warning')
        : trendIcon(this.context.extensionUri, q?.percent, this.config.colors);
    item.tooltip = this.tooltip(element.symbol);
    item.accessibilityInformation = {
      label: reset
        ? `${q?.name || element.symbol} ${element.symbol}，昨收 ${this.resetPrice(element.symbol)}，涨跌幅已重置，等待今日行情`
        : `${q?.name || element.symbol} ${element.symbol}，现价 ${q?.priceText || '未知'}，涨跌幅 ${percentText(q?.percent ?? null)}${stale ? '，非实时或缓存' : ''}`
    };
    if (!reset) this.insights.decorate(item, q, 'a', stale);
    return this.activity.decorate(item, element);
  }
  tooltip(symbol) {
    const q = this.quotes.get(symbol),
      tip = new vscode.MarkdownString();
    tip.isTrusted = false;
    tip.supportHtml = false;
    tip.appendText(
      this.dailyReset(symbol)
        ? `${q?.name || symbol}（${symbol}）\n\n上个交易日收盘价：${this.resetPrice(symbol)}\n涨跌幅已重置为 0.00%，等待今日行情；重置值不是实时涨跌幅。`
        : q
          ? `${q.name}（${symbol}）\n\n现价：${q.priceText}　涨跌幅：${percentText(q.percent)}\n涨跌额：${signed(q.delta, 3)}　昨收：${q.previousClose}\n最高：${q.high ?? '—'}　最低：${q.low ?? '—'}\n行情时间：${q.date} ${quoteClock(q.timestamp)}（北京）`
          : `${symbol}\n尚未获取行情`
    );
    if (this.paused) tip.appendText('\n自动刷新已暂停。');
    if (this.stale(symbol)) tip.appendText('\n当前为缓存、非当日行情或行情未更新，请核对行情时间。');
    if (this.errors.has(symbol)) tip.appendText('\n' + this.errors.get(symbol));
    if (this.config.groups.length && this.config.symbols.includes(symbol))
      tip.appendText('\n分组：' + this.grouping.bucket(this.grouping.idFor(symbol))?.name);
    tip.appendText('\n拖动可排序或移动分组；点击查看详细图表，右键可移动分组、删除自选或在底部显示。');
    return tip;
  }
  publish(structural = false) {
    if (this.disposed) return;
    this.activity?.refresh();
    this.insights?.reconcile();
    this.tree.title = this.hidden ? '运行和调试' : '自选股（名称 / 代码）';
    if (this.hidden) {
      this.tree.description = undefined;
      this.tree.message = undefined;
      if (structural) this.emitter.fire(undefined);
      this.renderStatus();
      return;
    }
    const clock = this.clock();
    const hasOverseas = this.overseas && (this.overseas.symbols.hk.length || this.overseas.symbols.us.length);
    const description = !this.config.enabled
      ? '已禁用'
      : this.paused
        ? '已暂停'
        : `${hasOverseas ? 'A股 ' : ''}${PHASE_LABELS[clock.phase]} · ${clock.polling ? '10秒刷新' : '自动刷新已停止'}${hasOverseas ? '；港美股按各自时段刷新' : ''}`;
    if (this.tree.description !== description) this.tree.description = description;
    const failing = this.config.symbols.filter((s) => this.errors.has(s)).length;
    const message =
      this.config.error || (failing ? `${failing} 个代码获取失败，已保留上次行情，可悬停查看原因。` : undefined);
    if (this.tree.message !== message) this.tree.message = message;
    let reorder = false;
    const changes: string[] = [];
    for (const symbol of this.config.symbols) {
      const signature = JSON.stringify([
        this.quotes.get(symbol),
        this.errors.get(symbol),
        this.stale(symbol),
        this.dailyReset(symbol),
        this.paused
      ]);
      if (signature !== this.signatures.get(symbol)) {
        changes.push(symbol);
        reorder = true;
        this.signatures.set(symbol, signature);
      }
    }
    if (structural || (reorder && this.config.sortBy !== 'manual')) this.emitter.fire(undefined);
    else for (const symbol of changes) this.emitter.fire(this.element(symbol));
    this.renderStatus();
  }
  renderStatus() {
    if (!this.config.enabled || this.hidden) {
      if (this.statusVisible) {
        this.status.hide();
        this.statusVisible = false;
      }
      return;
    }
    const symbol = this.config.selected,
      q = this.quotes.get(symbol);
    const reset = this.dailyReset(symbol),
      stale = reset || this.stale(symbol);
    const text = reset
      ? `[${q?.name || symbol}] ${this.resetPrice(symbol)} $(dash) (${percentText(0)}) · 待今日行情`
      : q
        ? `[${q.name}] ${q.priceText} ${q.percent > 0 ? '$(triangle-up)' : q.percent < 0 ? '$(triangle-down)' : '$(dash)'} (${percentText(q.percent)})${this.paused ? ' · 暂停' : stale ? ' · 未更新' : ''}`
        : `[${symbol === INDEX_SYMBOL ? '上证指数' : symbol}] ${this.errors.has(symbol) ? '获取失败' : '待获取'}`;
    const tooltip = this.tooltip(symbol);
    tooltip.appendText('\n点击切换上证指数 / 自选股。');
    const color = !stale && !this.paused ? stockStatusColor(q?.percent, this.config.colors) : undefined;
    if (text !== this.statusRendered.text) this.status.text = text;
    if (tooltip.value !== this.statusRendered.tooltip) this.status.tooltip = tooltip;
    if (color !== this.statusRendered.color)
      this.status.color = color?.startsWith('#') ? color : color ? new vscode.ThemeColor(color) : undefined;
    this.statusRendered = { text, tooltip: tooltip.value, color };
    if (!this.statusVisible) {
      this.status.show();
      this.statusVisible = true;
    }
  }
  refresh() {
    if (this.disposed || this.hidden || !this.config.enabled) return Promise.resolve();
    if (this.inflight && this.abort?.signal.aborted) return this.inflight.then(() => this.refresh());
    if (this.inflight) return this.inflight;
    const symbols = [...new Set([INDEX_SYMBOL, ...this.config.symbols])];
    const generation = this.generation;
    const abort = (this.abort = new AbortController());
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      try {
        const result = await this.provider.load(symbols, abort.signal);
        if (this.disposed || abort.signal.aborted || generation !== this.generation) return;
        this.errors = result.errors;
        for (const [symbol, q] of result.quotes) {
          if (isQuote(q) && q.date <= this.clock().date) this.quotes.set(symbol, q);
          else this.errors.set(symbol, '行情字段或日期异常，已保留上次成功行情');
        }
        this.cached = false;
        if (result.errors.size) this.log(`自选股：${result.errors.size} 个代码获取失败`);
        await this.context.globalState
          .update('stockQuotes', symbols.map((s) => this.quotes.get(s)).filter(Boolean))
          .catch(() => {});
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) {
          for (const symbol of symbols) this.errors.set(symbol, error.message);
          this.log('自选股行情请求失败');
        }
      } finally {
        this.inflight = null;
        this.abort = null;
        if (!this.disposed) this.publish(false);
      }
    })();
    return this.inflight;
  }
  async add(input, groupId?: string) {
    // View-title actions can pass the focused tree item instead of stock input.
    if (typeof input !== 'string' && !Array.isArray(input)) return this.searchAndAdd();
    let additions;
    try {
      try {
        additions = normalizeSymbols(input);
      } catch (error) {
        if (typeof input !== 'string' || !input.trim() || /[,，;；]/.test(input)) throw error;
        return this.searchAndAdd(input, groupId ? 'a' : undefined, groupId);
      }
    } catch (e) {
      return privateUI.showErrorMessage(e.message);
    }
    return this.enqueueSettings(async () => {
      if (this.disposed || this.hidden) return;
      if (groupId !== undefined && !this.grouping.bucket(groupId)) throw new Error('目标分组已删除，请重新选择。');
      let symbols;
      try {
        symbols = normalizeSymbols([...this.config.symbols, ...additions]);
      } catch (e) {
        return privateUI.showErrorMessage(e.message);
      }
      if (groupId === undefined) await this.writeSetting('stocks.symbols', symbols);
      else {
        const adding = new Set(additions);
        const groups = this.config.groups.map((g) => ({
          ...g,
          symbols: [...g.symbols.filter((s) => !adding.has(s)), ...(g.id === groupId ? additions : [])]
        }));
        await this.writeSettings(
          [
            ['stocks.symbols', symbols],
            ['stocks.groups', normalizeGroups(groups, symbols)]
          ],
          JSON.stringify(symbols) !== JSON.stringify(this.config.symbols)
        );
      }
    });
  }
  enqueueSettings(operation) {
    const job = this.settingsQueue.then(operation);
    this.settingsQueue = job.catch(() => {});
    return job;
  }
  updateSetting(key, value) {
    return this.enqueueSettings(() => this.writeSetting(key, value));
  }
  async writeSetting(key, value) {
    const entries = [[key, value]];
    if (key === 'stocks.symbols' && this.config.groups.length)
      entries.push(['stocks.groups', normalizeGroups(this.config.groups, value)]);
    return this.writeSettings(
      entries,
      !['stocks.groups', 'stocks.trendDisplay', 'stocks.volumeComparison'].includes(key) && !COLOR_KEYS.has(key)
    );
  }
  async writeSettings(entries, reload = true) {
    this.writingSettings = (this.writingSettings || 0) + 1;
    try {
      for (const [key, value] of entries) await this.settings.set(key, value);
    } finally {
      this.writingSettings--;
      if (!this.disposed) {
        if (reload) {
          this.generation++;
          this.abort?.abort();
        }
        this.config = this.readConfig();
        this.syncOverseas();
        this.publish(true);
        if (reload && this.config.enabled && !this.paused)
          void (this.inflight || Promise.resolve()).then(() => {
            if (!this.disposed && this.config.enabled && !this.paused) return this.refresh();
          });
      }
    }
  }
  handleDrag(source, transfer, token) {
    if (
      this.disposed ||
      this.hidden ||
      !this.config.enabled ||
      token.isCancellationRequested ||
      !Array.isArray(source) ||
      !source.length
    )
      return;
    const market = source[0]?.market || 'a';
    if (
      source.every(
        (item) =>
          item?.kind === 'stockGroup' &&
          (('market' in item ? item.market : undefined) || 'a') === market &&
          this.groupingFor(market)?.groups.some((g) => g.id === item.id)
      )
    ) {
      transfer.set(
        WATCHLIST_MIME,
        new vscode.DataTransferItem({ owner: this.dragIdentity, market, groupIds: source.map((item) => item.id) })
      );
      return;
    }
    if (
      source.every(
        (item) =>
          item?.kind === 'overseasStock' &&
          item.market === source[0].market &&
          this.overseas.symbols[item.market]?.includes(item.symbol)
      )
    ) {
      transfer.set(
        WATCHLIST_MIME,
        new vscode.DataTransferItem({
          owner: this.dragIdentity,
          market: source[0].market,
          symbols: source.map((item) => item.symbol)
        })
      );
      return;
    }
    if (source.some((item) => item?.kind !== 'stock' || !this.config.symbols.includes(item.symbol))) return;
    transfer.set(
      WATCHLIST_MIME,
      new vscode.DataTransferItem({ owner: this.dragIdentity, symbols: source.map((item) => item.symbol) })
    );
  }
  handleDrop(target, transfer, token) {
    const payload = transfer.get(WATCHLIST_MIME)?.value;
    if (
      this.disposed ||
      this.hidden ||
      !this.config.enabled ||
      token.isCancellationRequested ||
      payload?.owner !== this.dragIdentity
    )
      return;
    if (Array.isArray(payload.groupIds)) {
      const market = payload.market || 'a',
        grouping = this.groupingFor(market);
      if (
        !grouping ||
        (target &&
          ((target.market || 'a') !== market || !['group', 'overseasGroup', 'stockGroup'].includes(target.kind)))
      )
        return;
      return grouping.reorder(payload.groupIds, target?.kind === 'stockGroup' ? target.id : undefined, token);
    }
    if (!Array.isArray(payload.symbols)) return;
    if (payload.market) return this.overseas.reorder(payload, target, token);
    return this.enqueueSettings(async () => {
      if (this.disposed || token.isCancellationRequested || !this.config.enabled) return;
      if (this.hidden) return;
      if (this.config.groups.length) {
        if (target && ((target.market || 'a') !== 'a' || !['group', 'stockGroup', 'stock'].includes(target.kind)))
          return;
        const id =
          target?.kind === 'stockGroup'
            ? target.id
            : target?.kind === 'stock'
              ? this.grouping.idFor(target.symbol)
              : UNGROUPED;
        if (!this.grouping.bucket(id) || payload.symbols.some((s) => !this.config.symbols.includes(s))) return;
        return this.grouping.moveNow(payload.symbols, id, target?.kind === 'stock' ? target.symbol : undefined);
      }
      const visible = orderedSymbols(this.config.symbols, this.quotes, this.config.sortBy);
      const moving = new Set<string>(payload.symbols);
      if (!moving.size || [...moving].some((symbol) => !visible.includes(symbol))) return;
      if (
        target &&
        target.kind !== 'group' &&
        (target.kind !== 'stock' || !visible.includes(target.symbol) || moving.has(target.symbol))
      )
        return;
      const selected = visible.filter((symbol) => moving.has(symbol));
      const rest = visible.filter((symbol) => !moving.has(symbol));
      let at = rest.length;
      if (target?.kind === 'stock') {
        at = rest.indexOf(target.symbol);
        // Dropping lower moves after the target; dropping higher moves before it.
        if (visible.indexOf(selected[0]) < visible.indexOf(target.symbol)) at++;
      }
      const next = [...rest.slice(0, at), ...selected, ...rest.slice(at)];
      if (next.every((symbol, index) => symbol === visible[index])) return;
      this.writingSettings = (this.writingSettings || 0) + 1;
      try {
        await this.settings.set('stocks.symbols', next);
        if (this.config.sortBy !== 'manual') await this.settings.set('stocks.sortBy', 'manual');
      } catch (error) {
        if (!this.disposed) void privateUI.showErrorMessage(`无法保存自选股顺序：${error.message || '请重试'}`);
      } finally {
        this.writingSettings--;
        if (!this.disposed) {
          this.config = this.readConfig();
          this.publish(true);
        }
      }
    });
  }
  searchAndAdd(initial = '', marketFilter?: string, groupId?: string) {
    if (this.disposed || this.hidden) return Promise.resolve();
    if (groupId !== undefined) {
      if (!this.grouping.bucket(groupId)) return Promise.reject(new Error('目标分组已删除，请重新选择。'));
      marketFilter = 'a';
    }
    const picker = vscode.window.createQuickPick<StockPick>();
    picker.title = '搜索并添加自选股';
    picker.placeholder = '搜索A股、港股、美股：例如 贵州茅台 / 腾讯 / 苹果 / 00700 / AAPL';
    if (marketFilter === 'a') {
      picker.title = '添加 A 股自选';
      picker.placeholder = '输入 A 股名称、拼音或代码，例如 贵州茅台 / gzmt / 600519';
    }
    if (groupId !== undefined) picker.title = `添加 A 股到「${this.grouping.bucket(groupId)?.name}」`;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.ignoreFocusOut = true;
    let timer,
      abort,
      generation = 0,
      closed = false,
      accepting = false;
    const update = async (value) => {
      const current = ++generation;
      abort?.abort();
      clearTimeout(timer);
      picker.busy = false;
      picker.items = [];
      picker.activeItems = [];
      if (!value.trim()) return;
      let direct,
        directMarket = 'a';
      try {
        direct = normalizeSymbols(value);
      } catch {
        /* A name or partial code needs lookup. */
      }
      if (!direct && /^(?:hk\d{1,5}|\d{5}|\d{1,5}\.hk)$/i.test(value.trim())) {
        direct = [normalizeOverseas(value, 'hk')];
        directMarket = 'hk';
      } else if (!direct && /^(?:us[A-Z][A-Z0-9.]{0,13}|[A-Z][A-Z0-9]{0,9}(?:\.[A-Z]{1,3})?)$/.test(value.trim())) {
        direct = [normalizeOverseas(value, 'us')];
        directMarket = 'us';
      }
      if (marketFilter && directMarket !== marketFilter) direct = undefined;
      if (direct?.length) {
        picker.items = [
          {
            label: direct.length === 1 ? `添加 ${direct[0]}` : `批量添加 ${direct.length} 个代码`,
            description: `${directMarket === 'hk' ? '港股' : directMarket === 'us' ? '美股' : 'A股'} · ${direct.join(', ')}`,
            market: directMarket,
            symbols: direct,
            alwaysShow: true
          }
        ];
        picker.activeItems = [picker.items[0]];
      }
      timer = setTimeout(async () => {
        if (closed || this.disposed) return;
        const request = (abort = new AbortController());
        picker.busy = true;
        try {
          if (direct?.length > 1) return;
          const result = await (this.search.searchAll
            ? this.search.searchAll(value.trim(), request.signal)
            : this.search.search(value.trim(), request.signal));
          if (closed || this.disposed || request.signal.aborted || current !== generation) return;
          const entries = result
            .filter(
              (item) =>
                !marketFilter || (('market' in item ? (item.market as string) : undefined) || 'a') === marketFilter
            )
            .map((item) => {
              const market = ('market' in item ? (item.market as string) : undefined) || 'a',
                selected = market === 'a' ? this.config.symbols : this.overseas.symbols[market];
              return {
                label: item.name,
                description: `${market === 'hk' ? '港股' : market === 'us' ? '美股' : 'A股'} · ${item.symbol}`,
                detail: `${item.pinyin || ''}${selected?.includes(item.symbol) ? ' · 已在自选' : ''}`,
                market,
                symbols: [item.symbol],
                alwaysShow: true
              };
            });
          picker.items = entries.length
            ? entries
            : direct?.length
              ? picker.items
              : [{ label: '未找到匹配股票，请换一个名称或完整代码', empty: true, alwaysShow: true }];
          picker.activeItems = picker.items[0]?.symbols ? [picker.items[0]] : [];
        } catch (e) {
          if (!closed && !request.signal.aborted && current === generation && !direct?.length)
            picker.items = [
              {
                label: '搜索失败，重新输入可重试；也可直接输入完整代码',
                detail: e.message,
                empty: true,
                alwaysShow: true
              }
            ];
        } finally {
          if (!closed && current === generation) picker.busy = false;
        }
      }, 300);
    };
    return new Promise<void>((resolve) => {
      const listeners = [
        picker.onDidChangeValue((value) => void update(value)),
        picker.onDidAccept(async () => {
          const item = picker.selectedItems[0] || picker.activeItems?.[0];
          if (!item?.symbols || accepting) return;
          accepting = true;
          try {
            if (item.market === 'hk' || item.market === 'us')
              await this.overseas.mutate(item.market, (list) => [...list, ...item.symbols!]);
            else await this.add(item.symbols, groupId);
            picker.hide();
          } catch (e) {
            accepting = false;
            void privateUI.showErrorMessage(e.message);
          }
        }),
        picker.onDidHide(() => {
          closed = true;
          abort?.abort();
          clearTimeout(timer);
          for (const listener of listeners) listener.dispose();
          picker.dispose();
          this.activePicker = null;
          resolve();
        })
      ];
      this.activePicker?.hide();
      this.activePicker = picker;
      picker.value = initial;
      picker.show();
      void update(initial);
    });
  }
  async remove(element) {
    let symbol = typeof element === 'string' ? normalizeSymbol(element) : element?.symbol;
    if (!symbol) {
      const selected = await privateUI.showQuickPick(
        this.config.symbols.map((s) => ({ label: this.quotes.get(s)?.name || s, description: s, symbol: s })),
        { title: '删除自选股' }
      );
      symbol = selected?.symbol;
    }
    if (!symbol) return;
    if (symbol === this.config.selected && symbol !== INDEX_SYMBOL) {
      await this.updateSetting('stocks.statusBarSymbol', INDEX_SYMBOL);
    }
    await this.enqueueSettings(() =>
      this.writeSetting(
        'stocks.symbols',
        this.config.symbols.filter((s) => s !== symbol)
      )
    );
  }
  async selectStatus(element) {
    let symbol = typeof element === 'string' ? normalizeSymbol(element) : element?.symbol;
    if (!symbol) {
      const entries = [...new Set([INDEX_SYMBOL, ...this.config.symbols])].map((s) => {
        const q = this.quotes.get(s);
        return {
          label: q?.name || (s === INDEX_SYMBOL ? '上证指数' : s),
          description: this.dailyReset(s)
            ? `${s}  ${this.resetPrice(s)}  ${percentText(0)} · 待今日行情${s === this.config.selected ? '  当前显示' : ''}`
            : `${s}  ${q?.priceText || '—'}  ${percentText(q?.percent ?? null)}${s === this.config.selected ? '  当前显示' : ''}`,
          symbol: s
        };
      });
      const selected = await privateUI.showQuickPick(entries, { title: '选择底部状态栏显示的指数 / 个股' });
      symbol = selected?.symbol;
    }
    if (!symbol) return;
    if (symbol !== INDEX_SYMBOL && !this.config.symbols.includes(symbol))
      return privateUI.showErrorMessage('请先将该代码加入自选股');
    await this.updateSetting('stocks.statusBarSymbol', symbol);
  }
  async sort() {
    const chosen = await privateUI.showQuickPick(
      [
        { label: '手动顺序（可拖拽）', mode: 'manual' },
        { label: '涨幅从高到低', mode: 'percentDesc' },
        { label: '跌幅从大到小', mode: 'percentAsc' }
      ],
      { title: '自选股排序' }
    );
    if (chosen) await this.updateSetting('stocks.sortBy', chosen.mode);
  }
  async togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      this.abort?.abort();
      for (const abort of Object.values(this.overseas.abort)) abort?.abort();
    }
    await this.context.globalState.update('stocksPaused', this.paused);
    this.publish(false);
    this.overseas.publishAll();
    if (!this.paused) {
      if (this.inflight) await this.inflight;
      await Promise.all(Object.values(this.overseas.inflight));
      return Promise.all([this.refresh(), this.overseas.refreshAll()]);
    }
  }
  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) {
      this.generation++;
      this.abort?.abort();
      for (const controller of Object.values(this.overseas.abort)) controller?.abort();
      this.activePicker?.hide();
      this.overseas.picker?.hide();
    }
    this.publish(true);
    if (!hidden && !this.paused && this.config.enabled) {
      const pending = [this.inflight, ...Object.values(this.overseas.inflight)].filter(Boolean);
      void Promise.all(pending).then(() => {
        if (!this.disposed && !this.hidden && !this.paused && this.config.enabled)
          return Promise.all([this.refresh(), this.overseas.refreshAll()]);
      });
    }
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.abort?.abort();
    this.activePicker?.hide();
    this.activity.dispose();
    this.insights.dispose();
    this.overseas.dispose();
    this.listener.dispose();
    this.tree.dispose();
    this.status.dispose();
    this.emitter.dispose();
  }
}
export { WatchlistController };
