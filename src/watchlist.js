'use strict';
const vscode = require('vscode');
const { POLL_MS, PHASE_LABELS, stockSession, timeToMinute, stockTradingMinute } = require('./market');
const { INDEX_SYMBOL, normalizeSymbol, normalizeSymbols, isQuote, signed, percentText, orderedSymbols, StockProvider } = require('./quotes');
const { quoteClock } = require('./view');
const { StockSearch } = require('./stock-search');
const { StockSettings } = require('./stock-settings');
const { trendIcon } = require('./trend-icon');
const WATCHLIST_MIME = 'application/vnd.code.tree.welove42.ashareturnover.watchlist';

class WatchlistController {
  constructor(context, { provider = new StockProvider(), search = new StockSearch(), now = () => new Date(), log = () => {} } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.log = log;
    this.search = search; this.settings = new StockSettings(context, log);
    this.disposed = false; this.inflight = null; this.abort = null; this.lastAttempt = -Infinity; this.generation = 0;
    this.quotes = new Map(); this.errors = new Map(); this.signatures = new Map();
    this.group = { kind: 'group' }; this.elements = new Map();
    this.settingsQueue = Promise.resolve(); this.dragIdentity = {};
    this.cached = true; this.paused = Boolean(context.globalState.get('stocksPaused', false));
    const stored = context.globalState.get('stockQuotes', []);
    if (Array.isArray(stored)) for (const q of stored) if (isQuote(q)) this.quotes.set(q.symbol, q);
    this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView('welove42.aShareTurnover.watchlist', { treeDataProvider: this, showCollapseAll: true, dragAndDropController: {
      dragMimeTypes: [WATCHLIST_MIME], dropMimeTypes: [WATCHLIST_MIME],
      handleDrag: (source, transfer, token) => this.handleDrag(source, transfer, token),
      handleDrop: (target, transfer, token) => this.handleDrop(target, transfer, token)
    } });
    this.status = vscode.window.createStatusBarItem('aShareTurnover.selectedStock', vscode.StatusBarAlignment.Right, 99);
    this.status.name = '上证指数 / 自选股'; this.status.command = 'welove42.aShareTurnover.stocks.selectStatus';
    this.statusVisible = false; this.statusRendered = {};
    this.config = this.readConfig();
    this.phaseKey = '';
    this.listener = vscode.workspace.onDidChangeConfiguration(event => {
      if (this.writingSettings) return;
      if (!event.affectsConfiguration('aShareTurnover.stocks') && !event.affectsConfiguration('aShareTurnover.additionalClosedDates')) return;
      const previous = this.config;
      this.config = this.readConfig();
      const structural = previous.enabled !== this.config.enabled || JSON.stringify(previous.symbols) !== JSON.stringify(this.config.symbols) || previous.sortBy !== this.config.sortBy;
      const reload = previous.enabled !== this.config.enabled || structural || previous.selected !== this.config.selected;
      if (reload) { this.generation++; this.abort?.abort(); }
      this.publish(structural);
      if (reload && this.config.enabled && !this.paused) {
        void (this.inflight || Promise.resolve()).then(() => { if (!this.disposed && this.config.enabled && !this.paused) return this.refresh(); });
      }
    });
  }
  readConfig() {
    const c = vscode.workspace.getConfiguration('aShareTurnover');
    let symbols = [], error = '', selected = INDEX_SYMBOL;
    try { symbols = normalizeSymbols(this.settings.get('stocks.symbols', [])); } catch (e) { error = e.message; }
    try { selected = normalizeSymbol(this.settings.get('stocks.statusBarSymbol', INDEX_SYMBOL)); } catch { error ||= '状态栏代码无效，已使用上证指数'; }
    // A removed watchlist item cannot remain secretly selected in the status bar.
    if (selected !== INDEX_SYMBOL && !symbols.includes(selected)) selected = INDEX_SYMBOL;
    return { enabled: c.get('stocks.enabled', true), symbols, selected, error,
      sortBy: this.settings.get('stocks.sortBy', 'manual'), closedDates: c.get('additionalClosedDates', []) };
  }
  start() {
    const c = this.clock(); this.phaseKey = c.date + c.phase;
    this.publish(true); this.timer = setInterval(() => void this.tick(), 1000);
    if (this.config.enabled && !this.paused) void this.refresh();
  }
  clock() { return stockSession(this.now(), this.config.closedDates); }
  tick() {
    if (this.disposed) return;
    const clock = this.clock(), key = clock.date + clock.phase;
    const boundary = key !== this.phaseKey; this.phaseKey = key;
    this.publish(false);
    if (this.config.enabled && !this.paused && !this.inflight
      && ((clock.polling && this.now().getTime() - this.lastAttempt >= POLL_MS) || boundary)) return this.refresh();
  }
  stale(symbol) {
    const q = this.quotes.get(symbol), clock = this.clock();
    if (!q || this.cached || this.errors.has(symbol) || q.date !== clock.date) return true;
    return clock.polling && stockTradingMinute(clock.minute) - stockTradingMinute(timeToMinute(q.timestamp.slice(8, 12))) > 2;
  }
  getChildren(element) {
    if (!this.config.enabled) return [];
    if (!element) return this.config.symbols.length ? [this.group] : [];
    if (element.kind !== 'group') return [];
    return orderedSymbols(this.config.symbols, this.quotes, this.config.sortBy).map(symbol => this.element(symbol));
  }
  element(symbol) {
    if (!this.elements.has(symbol)) this.elements.set(symbol, { kind: 'stock', symbol });
    return this.elements.get(symbol);
  }
  getParent(element) { return element.kind === 'stock' ? this.group : undefined; }
  getTreeItem(element) {
    if (element.kind === 'group') {
      const item = new vscode.TreeItem(`A Stock (${this.config.symbols.length})`, vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'a-share-watchlist'; item.description = '涨跌幅 · 现价 · 名称'; item.tooltip = '拖动个股到另一只个股可调整顺序；拖到本分组可移至末尾。'; return item;
    }
    const q = this.quotes.get(element.symbol), stale = this.stale(element.symbol);
    const label = q ? `${percentText(q.percent).padStart(7)}   ${q.priceText.padStart(8)}   [${q.name}]` : `—   —   [${element.symbol}]`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `stock:${element.symbol}`; item.contextValue = 'aShareStock';
    item.command = { command: 'welove42.aShareTurnover.stocks.openChart', title: '查看详细行情图表', arguments: [element.symbol] };
    item.description = this.errors.has(element.symbol) ? '获取失败' : stale ? q && q.date !== this.clock().date ? q.date.slice(5) : '缓存' : '';
    item.iconPath = this.errors.has(element.symbol) ? new vscode.ThemeIcon('warning')
      : trendIcon(this.context.extensionUri, q?.percent);
    item.tooltip = this.tooltip(element.symbol);
    item.accessibilityInformation = { label: `${q?.name || element.symbol} ${element.symbol}，现价 ${q?.priceText || '未知'}，涨跌幅 ${percentText(q?.percent ?? null)}${stale ? '，非实时或缓存' : ''}` };
    return item;
  }
  tooltip(symbol) {
    const q = this.quotes.get(symbol), tip = new vscode.MarkdownString();
    tip.isTrusted = false; tip.supportHtml = false;
    tip.appendText(q ? `${q.name}（${symbol}）\n\n现价：${q.priceText}　涨跌幅：${percentText(q.percent)}\n涨跌额：${signed(q.delta, 3)}　昨收：${q.previousClose}\n最高：${q.high ?? '—'}　最低：${q.low ?? '—'}\n行情时间：${q.date} ${quoteClock(q.timestamp)}（北京）` : `${symbol}\n尚未获取行情`);
    if (this.paused) tip.appendText('\n自动刷新已暂停。');
    if (this.stale(symbol)) tip.appendText('\n当前为缓存、非当日行情或行情未更新，请核对行情时间。');
    if (this.errors.has(symbol)) tip.appendText('\n' + this.errors.get(symbol));
    tip.appendText('\n拖动可调整顺序；点击查看详细图表，右键可删除自选或在底部显示。');
    return tip;
  }
  publish(structural = false) {
    if (this.disposed) return;
    const clock = this.clock();
    const description = !this.config.enabled ? '已禁用' : this.paused ? '已暂停' : `${PHASE_LABELS[clock.phase]} · ${clock.polling ? '10秒刷新' : '自动刷新已停止'}`;
    if (this.tree.description !== description) this.tree.description = description;
    const failing = this.config.symbols.filter(s => this.errors.has(s)).length;
    const message = this.config.error || (failing ? `${failing} 个代码获取失败，已保留上次行情，可悬停查看原因。` : undefined);
    if (this.tree.message !== message) this.tree.message = message;
    let reorder = false;
    const changes = [];
    for (const symbol of this.config.symbols) {
      const signature = JSON.stringify([this.quotes.get(symbol), this.errors.get(symbol), this.stale(symbol), this.paused]);
      if (signature !== this.signatures.get(symbol)) { changes.push(symbol); reorder = true; this.signatures.set(symbol, signature); }
    }
    if (structural || (reorder && this.config.sortBy !== 'manual')) this.emitter.fire(undefined);
    else for (const symbol of changes) this.emitter.fire(this.element(symbol));
    this.renderStatus();
  }
  renderStatus() {
    if (!this.config.enabled) { if (this.statusVisible) { this.status.hide(); this.statusVisible = false; } return; }
    const symbol = this.config.selected, q = this.quotes.get(symbol);
    const stale = this.stale(symbol);
    const text = q ? `[${q.name}] ${q.priceText} ${q.percent > 0 ? '$(triangle-up)' : q.percent < 0 ? '$(triangle-down)' : '$(dash)'} (${percentText(q.percent)})${this.paused ? ' · 暂停' : stale ? ' · 未更新' : ''}`
      : `[${symbol === INDEX_SYMBOL ? '上证指数' : symbol}] ${this.errors.has(symbol) ? '获取失败' : '待获取'}`;
    const tooltip = this.tooltip(symbol); tooltip.appendText('\n点击切换上证指数 / 自选股。');
    const color = !stale && !this.paused && q?.percent ? q.percent > 0 ? 'charts.red' : 'charts.green' : undefined;
    if (text !== this.statusRendered.text) this.status.text = text;
    if (tooltip.value !== this.statusRendered.tooltip) this.status.tooltip = tooltip;
    if (color !== this.statusRendered.color) this.status.color = color ? new vscode.ThemeColor(color) : undefined;
    this.statusRendered = { text, tooltip: tooltip.value, color };
    if (!this.statusVisible) { this.status.show(); this.statusVisible = true; }
  }
  refresh() {
    if (this.disposed || !this.config.enabled) return Promise.resolve();
    if (this.inflight && this.abort?.signal.aborted) return this.inflight.then(() => this.refresh());
    if (this.inflight) return this.inflight;
    const symbols = [...new Set([INDEX_SYMBOL, ...this.config.symbols])];
    const generation = this.generation;
    const abort = this.abort = new AbortController(); this.lastAttempt = this.now().getTime();
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
        await this.context.globalState.update('stockQuotes', symbols.map(s => this.quotes.get(s)).filter(Boolean)).catch(() => {});
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) { for (const symbol of symbols) this.errors.set(symbol, error.message); this.log('自选股行情请求失败'); }
      } finally {
        this.inflight = null; this.abort = null;
        if (!this.disposed) this.publish(false);
      }
    })();
    return this.inflight;
  }
  async add(input) {
    // View-title actions can pass the focused tree item instead of stock input.
    if (typeof input !== 'string' && !Array.isArray(input)) return this.searchAndAdd();
    let additions;
    try {
      try { additions = normalizeSymbols(input); }
      catch (error) {
        if (typeof input !== 'string' || !input.trim() || /[,，;；]/.test(input)) throw error;
        return this.searchAndAdd(input);
      }
    }
    catch (e) { return vscode.window.showErrorMessage(e.message); }
    return this.enqueueSettings(async () => {
      let symbols;
      try { symbols = normalizeSymbols([...this.config.symbols, ...additions]); }
      catch (e) { return vscode.window.showErrorMessage(e.message); }
      await this.writeSetting('stocks.symbols', symbols);
    });
  }
  enqueueSettings(operation) {
    const job = this.settingsQueue.then(operation);
    this.settingsQueue = job.catch(() => {});
    return job;
  }
  updateSetting(key, value) { return this.enqueueSettings(() => this.writeSetting(key, value)); }
  async writeSetting(key, value) {
    this.writingSettings = (this.writingSettings || 0) + 1;
    try { await this.settings.set(key, value); } finally { this.writingSettings--; }
    if (this.disposed) return;
    this.generation++; this.abort?.abort(); this.config = this.readConfig(); this.publish(true);
    if (this.config.enabled && !this.paused) void (this.inflight || Promise.resolve()).then(() => { if (!this.disposed && this.config.enabled && !this.paused) return this.refresh(); });
  }
  handleDrag(source, transfer, token) {
    if (this.disposed || token.isCancellationRequested || !Array.isArray(source) || !source.length) return;
    if (source.some(item => item?.kind !== 'stock' || !this.config.symbols.includes(item.symbol))) return;
    transfer.set(WATCHLIST_MIME, new vscode.DataTransferItem({ owner: this.dragIdentity, symbols: source.map(item => item.symbol) }));
  }
  handleDrop(target, transfer, token) {
    const payload = transfer.get(WATCHLIST_MIME)?.value;
    if (this.disposed || token.isCancellationRequested || payload?.owner !== this.dragIdentity || !Array.isArray(payload.symbols)) return;
    return this.enqueueSettings(async () => {
      if (this.disposed || token.isCancellationRequested || !this.config.enabled) return;
      const visible = orderedSymbols(this.config.symbols, this.quotes, this.config.sortBy);
      const moving = new Set(payload.symbols);
      if (!moving.size || [...moving].some(symbol => !visible.includes(symbol))) return;
      if (target && target.kind !== 'group' && (target.kind !== 'stock' || !visible.includes(target.symbol) || moving.has(target.symbol))) return;
      const selected = visible.filter(symbol => moving.has(symbol));
      const rest = visible.filter(symbol => !moving.has(symbol));
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
        if (!this.disposed) void vscode.window.showErrorMessage(`无法保存自选股顺序：${error.message || '请重试'}`);
      } finally {
        this.writingSettings--;
        if (!this.disposed) { this.config = this.readConfig(); this.publish(true); }
      }
    });
  }
  searchAndAdd(initial = '') {
    const picker = vscode.window.createQuickPick();
    picker.title = '搜索并添加自选股'; picker.placeholder = '输入中文名、拼音或股票编号，例如 贵州茅台 / 平安 / 600519；完整代码也可批量输入';
    picker.matchOnDescription = true; picker.matchOnDetail = true; picker.ignoreFocusOut = true;
    let timer, abort, generation = 0, closed = false, accepting = false;
    const update = async value => {
      const current = ++generation;
      abort?.abort(); clearTimeout(timer); picker.busy = false; picker.items = []; picker.activeItems = [];
      if (!value.trim()) return;
      let direct;
      try { direct = normalizeSymbols(value); } catch { /* A name or partial code needs lookup. */ }
      if (direct?.length) {
        picker.items = [{ label: direct.length === 1 ? `添加 ${direct[0]}` : `批量添加 ${direct.length} 个代码`, description: direct.join(', '), symbols: direct, alwaysShow: true }];
        picker.activeItems = [picker.items[0]];
      }
      timer = setTimeout(async () => {
        if (closed || this.disposed) return;
        const request = abort = new AbortController(); picker.busy = true;
        try {
          if (direct?.length > 1) return;
          const result = await this.search.search(value.trim(), request.signal);
          if (closed || this.disposed || request.signal.aborted || current !== generation) return;
          const entries = result.map(item => ({ label: item.name, description: item.symbol, detail: `${item.pinyin}${this.config.symbols.includes(item.symbol) ? ' · 已在自选' : ''}`, symbols: [item.symbol], alwaysShow: true }));
          picker.items = entries.length ? entries : direct?.length ? picker.items : [{ label: '未找到匹配股票，请换一个名称或完整代码', empty: true, alwaysShow: true }];
          picker.activeItems = picker.items[0]?.symbols ? [picker.items[0]] : [];
        } catch (e) {
          if (!closed && !request.signal.aborted && current === generation && !direct?.length) picker.items = [{ label: '搜索失败，重新输入可重试；也可直接输入完整代码', detail: e.message, empty: true, alwaysShow: true }];
        } finally { if (!closed && current === generation) picker.busy = false; }
      }, 300);
    };
    return new Promise(resolve => {
      const listeners = [picker.onDidChangeValue(value => void update(value)), picker.onDidAccept(async () => {
        const item = picker.selectedItems[0] || picker.activeItems?.[0]; if (!item?.symbols || accepting) return;
        accepting = true;
        try { await this.add(item.symbols); picker.hide(); } catch (e) { accepting = false; void vscode.window.showErrorMessage(e.message); }
      }), picker.onDidHide(() => {
        closed = true; abort?.abort(); clearTimeout(timer); for (const listener of listeners) listener.dispose(); picker.dispose(); this.activePicker = null; resolve();
      })];
      this.activePicker?.hide(); this.activePicker = picker; picker.value = initial; picker.show(); void update(initial);
    });
  }
  async remove(element) {
    let symbol = typeof element === 'string' ? normalizeSymbol(element) : element?.symbol;
    if (!symbol) {
      const selected = await vscode.window.showQuickPick(this.config.symbols.map(s => ({ label: this.quotes.get(s)?.name || s, description: s, symbol: s })), { title: '删除自选股' });
      symbol = selected?.symbol;
    }
    if (!symbol) return;
    if (symbol === this.config.selected && symbol !== INDEX_SYMBOL) {
      await this.updateSetting('stocks.statusBarSymbol', INDEX_SYMBOL);
    }
    await this.enqueueSettings(() => this.writeSetting('stocks.symbols', this.config.symbols.filter(s => s !== symbol)));
  }
  async selectStatus(element) {
    let symbol = typeof element === 'string' ? normalizeSymbol(element) : element?.symbol;
    if (!symbol) {
      const entries = [...new Set([INDEX_SYMBOL, ...this.config.symbols])].map(s => {
        const q = this.quotes.get(s);
        return { label: q?.name || (s === INDEX_SYMBOL ? '上证指数' : s),
          description: `${s}  ${q?.priceText || '—'}  ${percentText(q?.percent ?? null)}${s === this.config.selected ? '  当前显示' : ''}`, symbol: s };
      });
      const selected = await vscode.window.showQuickPick(entries, { title: '选择底部状态栏显示的指数 / 个股' });
      symbol = selected?.symbol;
    }
    if (!symbol) return;
    if (symbol !== INDEX_SYMBOL && !this.config.symbols.includes(symbol)) return vscode.window.showErrorMessage('请先将该代码加入自选股');
    await this.updateSetting('stocks.statusBarSymbol', symbol);
  }
  async sort() {
    const chosen = await vscode.window.showQuickPick([
      { label: '手动顺序（可拖拽）', mode: 'manual' }, { label: '涨幅从高到低', mode: 'percentDesc' }, { label: '跌幅从大到小', mode: 'percentAsc' }
    ], { title: '自选股排序' });
    if (chosen) await this.updateSetting('stocks.sortBy', chosen.mode);
  }
  async togglePause() {
    this.paused = !this.paused; if (this.paused) this.abort?.abort();
    await this.context.globalState.update('stocksPaused', this.paused);
    this.publish(false);
    if (!this.paused) { if (this.inflight) await this.inflight; return this.refresh(); }
  }
  dispose() {
    this.disposed = true; clearInterval(this.timer); this.abort?.abort();
    this.activePicker?.hide();
    this.listener.dispose(); this.tree.dispose(); this.status.dispose(); this.emitter.dispose();
  }
}
module.exports = { WatchlistController };
