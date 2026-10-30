'use strict';

const vscode = require('vscode');
const privateUI = require('./privacy-ui');
const { MarketProvider } = require('./provider');
const { POLL_MS, session, isSnapshot, PHASE_LABELS } = require('./market');
const { view } = require('./view');
const { WatchlistController } = require('./watchlist');
const { NewsController } = require('./news');
const { ChartController } = require('./charts');
const { GlobalIndicesController } = require('./global-indices');
const { FundsController } = require('./funds');
const { CommoditiesController } = require('./commodities');
const { warnLegacy } = require('./legacy');
const { marketRisk } = require('./risk');
const { marketTemperature, temperatureView } = require('./temperature');
const { TemperatureHistory } = require('./temperature-history');
const { TemperatureChartController } = require('./temperature-chart');
const { SectorsController } = require('./sectors');
const { ReminderController } = require('./reminders');
const { BossKey } = require('./boss-key');
const { DebugCoverProvider } = require('./debug-cover');

class TurnoverController {
  constructor(context, provider, now = () => new Date()) {
    this.context = context;
    this.now = now;
    this.disposed = false;
    this.lastAttempt = -Infinity;
    this.lastPhase = '';
    this.lastDate = '';
    this.inflight = null;
    this.rendered = null;
    this.visible = false;
    this.state = { paused: Boolean(context.globalState.get('paused', false)), cached: false, error: '', busy: false };
    const cached = context.globalState.get('snapshot');
    this.snapshot = isSnapshot(cached) ? cached : null;
    this.state.cached = Boolean(this.snapshot);
    this.output = vscode.window.createOutputChannel('A股成交额');
    this.item = vscode.window.createStatusBarItem('aShareTurnover', vscode.StatusBarAlignment.Right, 100);
    this.item.name = '沪深 A 股成交额';
    this.item.command = 'welove42.aShareTurnover.showMenu';
    this.temperatureItem = vscode.window.createStatusBarItem('aShareTurnover.temperature', vscode.StatusBarAlignment.Right, 99);
    this.temperatureItem.name = '沪深A股市场温度';
    this.temperatureItem.command = 'welove42.aShareTurnover.showTemperature';
    this.temperatureOutput = vscode.window.createOutputChannel('A股市场温度');
    this.temperatureHistory = new TemperatureHistory(context.globalState, session(this.now()).date, message => this.log(message));
    this.temperatureChart = new TemperatureChartController(context, () => this.temperatureChartData());
    this.provider = provider || new MarketProvider({ log: message => this.log(message), now });
    this.config = this.readConfig();
    this.requestController = null;
    this.listeners = [vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('aShareTurnover')) return;
      const wasEnabled = this.config.enabled;
      this.config = this.readConfig();
      if (!this.config.enabled) this.requestController?.abort();
      this.render();
      if (!wasEnabled && this.config.enabled && !this.state.paused) {
        // A quick disable/enable may still have an aborted request settling.
        // Wait for it, then start a fresh request even outside trading hours.
        void (this.inflight || Promise.resolve()).then(() => {
          if (!this.disposed && this.config.enabled && !this.state.paused) return this.refresh();
        });
      }
    })];
  }

  readConfig() {
    const config = vscode.workspace.getConfiguration('aShareTurnover');
    return {
      enabled: config.get('enabled', true),
      comparisonMode: config.get('comparisonMode', 'sameTime'),
      showDifferenceAmount: config.get('showDifferenceAmount', true),
      colorMode: config.get('colorMode', 'neutral'),
      additionalClosedDates: config.get('additionalClosedDates', []),
      temperature: { enabled: config.get('temperature.enabled', true), colorize: config.get('temperature.colorize', true) },
      risk: { enabled: config.get('risk.enabled', true), volumePercent: config.get('risk.volumePercent', 30), dropPercent: config.get('risk.dropPercent', 1.5) }
    };
  }

  log(message) { if (!this.disposed) this.output.appendLine(`[${this.now().toISOString()}] ${message}`); }

  start() {
    const clock = session(this.now(), this.config.additionalClosedDates);
    this.lastPhase = clock.phase;
    this.lastDate = clock.date;
    this.render();
    // This timer checks the local clock only. Network requests remain 10s apart.
    this.timer = setInterval(() => void this.tick(), 1000);
    if (this.config.enabled && !this.state.paused) void this.refresh();
  }

  tick() {
    if (this.disposed || this.hidden) return;
    const clock = session(this.now(), this.config.additionalClosedDates);
    const phaseChanged = clock.phase !== this.lastPhase;
    const dateChanged = clock.date !== this.lastDate;
    const wasTrading = this.lastPhase === 'trading';
    this.lastPhase = clock.phase;
    this.lastDate = clock.date;
    // Re-render locally so data staleness is visible even during a failed request.
    this.render();
    if (!this.config.enabled || this.state.paused || this.inflight) return;
    const elapsed = this.now().getTime() - this.lastAttempt;
    if ((clock.polling && elapsed >= POLL_MS) || (phaseChanged && wasTrading)
      || (dateChanged && this.lastAttempt !== -Infinity)) return this.refresh();
  }

  refresh(manual = false) {
    if (this.disposed || this.hidden || !this.config.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.lastAttempt = this.now().getTime();
    this.requestController = new AbortController();
    this.state.busy = true;
    this.render();
    this.inflight = this.fetchAndRender(this.requestController.signal, manual).finally(() => {
      this.inflight = null;
      this.requestController = null;
      this.state.busy = false;
      if (!this.disposed) this.render();
    });
    return this.inflight;
  }

  async fetchAndRender(signal, manual) {
    try {
      const snapshot = await this.provider.load(signal, manual);
      if (this.disposed || signal.aborted) return;
      if (!isSnapshot(snapshot)) throw new Error('行情快照校验失败');
      const clock = session(this.now(), this.config.additionalClosedDates);
      if (snapshot.date > clock.date) throw new Error('行情日期晚于北京时间，请核对系统时间');
      this.snapshot = snapshot;
      this.state.error = '';
      this.state.cached = false;
      this.temperatureHistory.rollover(clock.date);
      if (this.config.temperature.enabled) {
        const result = marketTemperature(snapshot, this.state, clock, this.now());
        this.temperatureHistory.record(result, snapshot.fetchedAt);
        await this.temperatureHistory.flush();
      }
      await this.context.globalState.update('snapshot', snapshot).catch(error => this.log(`缓存保存失败：${error.message}`));
    } catch (error) {
      if (this.disposed || signal.aborted) return;
      this.state.error = error.message || '网络连接失败';
      this.log(this.state.error);
    }
  }

  render() {
    if (this.disposed) return;
    const now = this.now(), clock = session(now, this.config.additionalClosedDates);
    this.temperatureHistory.rollover(clock.date);
    if (!this.config.enabled || this.hidden) {
      if (this.visible) { this.item.hide(); this.visible = false; }
      if (this.temperatureVisible) { this.temperatureItem.hide(); this.temperatureVisible = false; }
      this.temperatureChart.update();
      return;
    }
    const result = view(this.snapshot, this.state, this.config, clock, now);
    const risk = marketRisk(this.snapshot, this.state, this.riskSource?.(), clock, now, this.config.risk);
    if (risk) {
      result.text += ` | $(warning) ${risk.label}`;
      result.markdown += `\n\n**风险提示：${risk.label}**。沪深A股成交额较昨同刻 ${risk.volume >= 0 ? '+' : ''}${risk.volume.toFixed(2)}%，上证指数 ${risk.change.toFixed(2)}%；比较时间 ${risk.comparisonTime}，触发阈值为成交额变化至少 ${risk.volumeLimit}% 且指数跌幅至少 ${risk.dropLimit}%。`;
      result.accessibility += ` 风险提示：${risk.label}。`;
    }
    const markdown = result.markdown.replace(/[<>]/g, '');
    const previous = this.rendered;
    // Avoid invalidating the status bar/hover during unchanged clock checks.
    if (!previous || result.text !== previous.text) this.item.text = result.text;
    if (!previous || markdown !== previous.markdown) {
      // All tooltip text is generated locally; disable executable links and HTML.
      const tooltip = new vscode.MarkdownString(markdown);
      tooltip.isTrusted = false;
      tooltip.supportHtml = false;
      this.item.tooltip = tooltip;
    }
    if (!previous || result.color !== previous.color) {
      this.item.color = result.color ? new vscode.ThemeColor(result.color) : undefined;
    }
    if (!previous || result.accessibility !== previous.accessibility) {
      this.item.accessibilityInformation = { label: result.accessibility };
    }
    this.rendered = { ...result, markdown };
    if (!this.visible) { this.item.show(); this.visible = true; }
    this.renderTemperature(clock, now);
    this.temperatureChart.update();
  }

  renderTemperature(clock, now) {
    if (!this.config.temperature.enabled) {
      if (this.temperatureVisible) { this.temperatureItem.hide(); this.temperatureVisible = false; }
      return;
    }
    this.temperatureResult = marketTemperature(this.snapshot, this.state, clock, now);
    const result = temperatureView(this.temperatureResult, this.config.temperature), previous = this.temperatureRendered;
    if (!previous || previous.text !== result.text) this.temperatureItem.text = result.text;
    if (!previous || previous.markdown !== result.markdown) {
      const tooltip = new vscode.MarkdownString(result.markdown);
      tooltip.isTrusted = false; tooltip.supportHtml = false;
      this.temperatureItem.tooltip = tooltip;
    }
    if (!previous || previous.color !== result.color) this.temperatureItem.color = result.color ? new vscode.ThemeColor(result.color) : undefined;
    if (!previous || previous.accessibility !== result.accessibility) this.temperatureItem.accessibilityInformation = { label: result.accessibility };
    this.temperatureRendered = result;
    if (!this.temperatureVisible) { this.temperatureItem.show(); this.temperatureVisible = true; }
  }

  temperatureChartData() {
    const now = this.now(), clock = session(now, this.config.additionalClosedDates);
    const result = !this.config.enabled || !this.config.temperature.enabled
      ? { score: null, label: '已停用', reason: '温度或成交额模块已停用，当前曲线保留已采集记录。' }
      : marketTemperature(this.snapshot, this.state, clock, now);
    return { ...this.temperatureHistory.data(), current: { score: result.score, label: result.label, reason: result.reason }, phase: PHASE_LABELS[clock.phase] };
  }

  showTemperature() {
    if (this.disposed || this.hidden) return;
    this.temperatureHistory.rollover(session(this.now(), this.config.additionalClosedDates).date);
    this.temperatureChart.open();
  }

  showTemperatureDetails() {
    const now = this.now(), clock = session(now, this.config.additionalClosedDates);
    const result = marketTemperature(this.snapshot, this.state, clock, now);
    this.temperatureOutput.clear();
    this.temperatureOutput.appendLine(temperatureView(result, this.config.temperature).detail);
    this.temperatureOutput.show();
  }

  async togglePause() {
    this.state.paused = !this.state.paused;
    if (this.state.paused) this.requestController?.abort();
    await this.context.globalState.update('paused', this.state.paused);
    this.render();
    if (!this.state.paused) {
      if (this.inflight) await this.inflight;
      return this.refresh();
    }
  }

  async switchComparison() {
    const selected = await privateUI.showQuickPick([
      { label: '昨日同刻', description: '相同分钟的累计成交额（默认）', mode: 'sameTime' },
      { label: '昨日全天', description: '当前累计额对比上个交易日全天', mode: 'previousDay' }
    ], { title: '选择缩量 / 放量的比较口径', placeHolder: '昨日均指上一交易日' });
    if (selected) await vscode.workspace.getConfiguration('aShareTurnover')
      .update('comparisonMode', selected.mode, vscode.ConfigurationTarget.Global);
  }

  async showMenu() {
    const selected = await privateUI.showQuickPick([
      { label: '$(refresh) 立即刷新', command: 'welove42.aShareTurnover.refresh' },
      { label: '$(arrow-swap) 切换比较口径', command: 'welove42.aShareTurnover.switchComparison' },
      { label: '$(dashboard) 市场温度走势图', command: 'welove42.aShareTurnover.showTemperature' },
      { label: this.state.paused ? '$(play) 恢复自动刷新' : '$(debug-pause) 暂停自动刷新', command: 'welove42.aShareTurnover.togglePause' },
      { label: '$(settings-gear) 插件设置', command: 'settings' },
      { label: '$(output) 查看请求日志', command: 'welove42.aShareTurnover.showLog' }
    ], { title: '沪深 A 股成交额', placeHolder: this.item.accessibilityInformation?.label });
    if (!selected) return;
    if (selected.command === 'settings') return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:welove42.a-share-turnover');
    return vscode.commands.executeCommand(selected.command);
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) {
      this.requestController?.abort();
      this.temperatureChart.state?.panel.dispose();
      this.output.hide(); this.temperatureOutput.hide();
    }
    this.render();
    if (!hidden && !this.state.paused && this.config.enabled) {
      void (this.inflight || Promise.resolve()).then(() => { if (!this.disposed && !this.hidden && !this.state.paused && this.config.enabled) return this.refresh(); });
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.requestController?.abort();
    for (const listener of this.listeners) listener.dispose();
    this.item.dispose();
    this.temperatureItem.dispose();
    this.temperatureOutput.dispose();
    this.temperatureChart.dispose();
    this.output.dispose();
  }
}

function activate(context) {
  const controller = new TurnoverController(context);
  const stocks = new WatchlistController(context, { log: message => controller.log(message) });
  controller.riskSource = () => {
    const quote = stocks.quotes.get('sh000001');
    return quote ? { ...quote, stale: !stocks.config.enabled || stocks.paused || stocks.stale('sh000001') } : null;
  };
  const news = new NewsController(context, { log: message => controller.log(message) });
  const charts = new ChartController(context, { selected: () => stocks.config.selected, name: symbol => stocks.quotes.get(symbol)?.name });
  const globals = new GlobalIndicesController(context, { log: message => controller.log(message) });
  const funds = new FundsController(context, { log: message => controller.log(message) });
  const commodities = new CommoditiesController(context, { log: message => controller.log(message) });
  const sectors = new SectorsController(context);
  const reminders = new ReminderController(context);
  const bossKey = new BossKey(context, { controller, stocks, news, charts, globals, funds, commodities, sectors, reminders });
  const bind = (command, callback) => vscode.commands.registerCommand(command, (...args) => bossKey.hidden ? undefined : callback(...args));
  context.subscriptions.push(controller,
    bossKey, vscode.commands.registerCommand('welove42.aShareTurnover.toggleHidden', () => bossKey.toggle()),
    vscode.window.registerWebviewViewProvider('welove42.aShareTurnover.debugCover', new DebugCoverProvider(() => bossKey.hidden)),
    bind('welove42.aShareTurnover.refresh', () => controller.refresh(true)),
    bind('welove42.aShareTurnover.showMenu', () => controller.showMenu()),
    bind('welove42.aShareTurnover.togglePause', () => controller.togglePause()),
    bind('welove42.aShareTurnover.switchComparison', () => controller.switchComparison()),
    bind('welove42.aShareTurnover.showLog', () => controller.output.show()),
    bind('welove42.aShareTurnover.showTemperature', () => controller.showTemperature()),
    bind('welove42.aShareTurnover.showTemperatureDetails', () => controller.showTemperatureDetails()),
    bind('welove42.aShareTurnover.temperature.refresh', () => controller.refresh(true)),
    bind('welove42.aShareTurnover.sectors.refresh', () => sectors.retry()),
    bind('welove42.aShareTurnover.reminders.show', () => reminders.show()),
    stocks, news, charts, globals, funds, commodities, sectors, reminders,
    bind('welove42.aShareTurnover.commodities.add', input => commodities.add(input)),
    bind('welove42.aShareTurnover.commodities.remove', element => commodities.remove(element)),
    bind('welove42.aShareTurnover.commodities.refresh', () => commodities.refresh()),
    bind('welove42.aShareTurnover.commodities.togglePause', () => commodities.togglePause()),
    bind('welove42.aShareTurnover.commodities.open', element => commodities.open(element)),
    bind('welove42.aShareTurnover.funds.add', input => funds.add(input)),
    bind('welove42.aShareTurnover.funds.remove', element => funds.remove(element)),
    bind('welove42.aShareTurnover.funds.refresh', () => funds.refresh()),
    bind('welove42.aShareTurnover.funds.togglePause', () => funds.togglePause()),
    bind('welove42.aShareTurnover.funds.editHolding', element => funds.editHolding(element)),
    bind('welove42.aShareTurnover.funds.clearHolding', element => funds.clearHolding(element)),
    bind('welove42.aShareTurnover.funds.open', element => funds.open(element)),
    bind('welove42.aShareTurnover.globalIndices.search', () => globals.search()),
    bind('welove42.aShareTurnover.globalIndices.add', input => globals.add(input)),
    bind('welove42.aShareTurnover.globalIndices.remove', element => globals.remove(element)),
    bind('welove42.aShareTurnover.globalIndices.refresh', () => globals.refresh()),
    bind('welove42.aShareTurnover.globalIndices.togglePause', () => globals.togglePause()),
    bind('welove42.aShareTurnover.globalIndices.open', element => globals.open(element)),
    bind('welove42.aShareTurnover.stocks.openChart', (element, mode) => charts.open(element, mode)),
    bind('welove42.aShareTurnover.stocks.openInBrowser', element => charts.openExternal(element)),
    bind('welove42.aShareTurnover.chart.selectMode', () => charts.chooseMode()),
    bind('welove42.aShareTurnover.chart.selectIndicator', () => charts.chooseIndicator()),
    bind('welove42.aShareTurnover.chart.refresh', () => charts.refreshActive()),
    bind('welove42.aShareTurnover.chart.openInBrowser', () => charts.openActiveExternal()),
    bind('welove42.aShareTurnover.stocks.add', input => stocks.add(input)),
    bind('welove42.aShareTurnover.stocks.remove', element => stocks.remove(element)),
    bind('welove42.aShareTurnover.stocks.refresh', () => Promise.all([stocks.refresh(), stocks.overseas.refreshAll(true)])),
    bind('welove42.aShareTurnover.overseas.add', element => stocks.overseas.add(element)),
    bind('welove42.aShareTurnover.overseas.remove', element => stocks.overseas.remove(element)),
    bind('welove42.aShareTurnover.overseas.open', element => stocks.overseas.open(element)),
    bind('welove42.aShareTurnover.stocks.selectStatus', element => stocks.selectStatus(element)),
    bind('welove42.aShareTurnover.stocks.sort', () => stocks.sort()),
    bind('welove42.aShareTurnover.stocks.togglePause', () => stocks.togglePause()),
    bind('welove42.aShareTurnover.news.refresh', () => news.refresh()),
    bind('welove42.aShareTurnover.news.show', () => news.show()),
    bind('welove42.aShareTurnover.news.open', item => news.open(item)),
    bind('welove42.aShareTurnover.news.source', () => news.source()),
    bind('welove42.aShareTurnover.news.setToken', () => news.setToken()),
    bind('welove42.aShareTurnover.news.togglePause', () => news.togglePause())
  );
  controller.start(); stocks.start(); news.start(); globals.start(); funds.start(); commodities.start(); sectors.start(); reminders.start();
  if (!bossKey.hidden) void warnLegacy(context).catch(error => controller.log('旧版检测：' + error.message));
  return { getWatchlist: () => [...stocks.config.symbols], getSelectedSymbol: () => stocks.config.selected,
    getMarketTemperature: () => controller.temperatureResult ? { ...controller.temperatureResult } : undefined,
    getMarketTemperatureHistory: () => controller.temperatureHistory.data(),
    getStockSearchState: () => stocks.activePicker ? { title: stocks.activePicker.title, query: stocks.activePicker.value, busy: stocks.activePicker.busy,
      candidates: stocks.activePicker.items.filter(item => item.symbols).map(item => ({ name: item.label, symbols: [...item.symbols] })) } : undefined,
    getStockQuote: symbol => { const q = stocks.quotes.get(symbol); return q ? { ...q } : undefined; },
    getNewsCount: () => news.items.length, getChartState: symbol => charts.getState(symbol),
    getGlobalIndices: () => globals.selectedIds.map(id => ({ ...globals.catalog.get(id), quote: globals.quotes.get(id), error: globals.errors.get(id) })),
    getGlobalIndicesStatus: () => ({ enabled: globals.enabled, visible: globals.tree.visible, paused: globals.paused, lastAttempt: globals.lastAttempt, retryIntervalMs: globals.pollDelay }),
    getFunds: () => funds.symbols.map(code => ({ code, quote: funds.quotes.get(code), error: funds.errors.get(code), hasHolding: Boolean(funds.holdings[code]) })),
    getFundsStatus: () => ({ enabled: funds.enabled, visible: funds.tree.visible, paused: funds.paused, lastAttempt: funds.lastAttempt }),
    getCommodities: () => commodities.codes.map(code => ({ code, quote: commodities.quotes.get(code), error: commodities.errors.get(code) })),
    getCommoditiesStatus: () => ({ enabled: commodities.enabled, visible: commodities.tree.visible, paused: commodities.paused, lastAttempt: commodities.lastAttempt }),
    getLatestNews: () => news.items[0] ? { ...news.items[0] } : undefined };
}

module.exports = { activate, TurnoverController };
