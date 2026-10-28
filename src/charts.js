'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { normalizeSymbol, INDEX_SYMBOL } = require('./quotes');
const { POLL_MS, session } = require('./market');
const { ChartProvider, eastmoneyUrl, eastmoneyChartUrl, supportsChips } = require('./chart-data');

const MINUTE_MODES = ['m1', 'm5', 'm15', 'm30', 'm60'];
const MODES = ['eastmoney', 'chips', 'intraday', ...MINUTE_MODES, 'daily', 'weekly', 'monthly'];
const INDICATORS = ['macd', 'kdj', 'rsi', 'none'];
const isWebMode = mode => mode === 'eastmoney' || mode === 'chips';
const availableMode = (symbol, mode) => MODES.includes(mode) && (mode !== 'chips' || supportsChips(symbol)) ? mode : 'intraday';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function chartHtml(webview, context, symbol, token, mode = 'intraday') {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.js'));
  const indicators = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'indicators.js'));
  mode = availableMode(symbol, mode);
  const regularUrl = eastmoneyChartUrl(symbol), chipsUrl = supportsChips(symbol) ? eastmoneyChartUrl(symbol, 'chips') : '';
  const nonce = randomBytes(18).toString('base64');
  const periods = [['intraday', '分时'], ...MINUTE_MODES.map(value => [value, `${value.slice(1)}分钟`]), ['daily', '日K'], ['weekly', '周K'], ['monthly', '月K']]
    .map(([value, label]) => `<button type="button" data-period="${value}" aria-pressed="${mode === value}">${label}</button>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src https://quote.eastmoney.com; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${escapeHtml(css)}"><title>${escapeHtml(symbol)} 行情图表</title></head>
<body data-symbol="${escapeHtml(symbol)}" data-token="${token}" data-regular-url="${escapeHtml(regularUrl)}" data-chips-url="${escapeHtml(chipsUrl)}" data-mode="${escapeHtml(mode)}">
<main><div id="web-chart"${isWebMode(mode) ? '' : ' hidden'}><iframe id="eastmoney" title="东方财富 ${escapeHtml(symbol)} 专用图表" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>
<section id="local"${isWebMode(mode) ? ' hidden' : ''} aria-label="插件内行情图表"><div class="chart-tools"><span id="quote"></span><label id="range-label" hidden>显示 <select id="range"><option value="60">60根</option><option value="120">120根</option><option value="180" selected>180根</option></select></label></div><div class="period-tools" role="group" aria-label="图表周期">${periods}</div><p id="meta"></p>
<p id="status" role="status" aria-live="polite"></p><div id="plot" tabindex="0" role="group" aria-label="行情价格、成交量及技术指标"><svg id="svg" viewBox="0 0 1040 700" aria-hidden="true"></svg><div id="chart-tooltip" hidden></div></div><p id="detail">移动鼠标查看价格、成交量与指标。</p><p id="average-detail"></p><p id="indicator-detail"></p>
<p class="note" id="indicator-note"></p><p class="note">图表上方切换周期，右上角切换副图指标。分时黄色线为当日成交均价；K线含 MA5 / MA10 / MA20 / MA30 / MA60，成交量含 VMA5 / VMA10，周期按当前K线根数计算。鼠标或左右键定位可同步查看均线、MACD / KDJ / RSI。分钟K线时间为周期结束时间，最后一根可能尚未完成；成交量单位为手，时间为北京时间。可见且交易期间每10秒刷新。</p></section></main>
<script nonce="${nonce}" src="${escapeHtml(indicators)}"></script><script nonce="${nonce}" src="${escapeHtml(js)}"></script></body></html>`;
}

class ChartController {
  constructor(context, { provider = new ChartProvider(), now = () => new Date(), selected = () => INDEX_SYMBOL, name = () => undefined } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.selected = selected; this.name = name;
    this.panels = new Map(); this.cache = new Map(); this.disposed = false;
    const savedIndicator = context.globalState.get('chartIndicator', 'macd');
    this.indicator = INDICATORS.includes(savedIndicator) ? savedIndicator : 'macd';
    this.timer = setInterval(() => this.tick(), 1000);
  }
  resolve(element) { return normalizeSymbol(typeof element === 'string' ? element : element?.symbol || this.selected()); }
  async open(element, mode) {
    if (this.disposed) return;
    let symbol;
    try { symbol = this.resolve(element); } catch (e) { return vscode.window.showErrorMessage(e.message); }
    const requestedMode = MODES.includes(mode) ? mode : undefined;
    const defaultMode = vscode.workspace.getConfiguration('aShareTurnover').get('charts.defaultMode', 'intraday');
    const existing = this.panels.values().next().value;
    if (existing) {
      const nextMode = availableMode(symbol, requestedMode || existing.mode);
      if (existing.symbol !== symbol) {
        this.cancel(existing); this.panels.clear();
        existing.symbol = symbol; existing.mode = nextMode; existing.data = null; existing.ready = false; existing.pendingRefresh = false;
        existing.token = randomBytes(24).toString('hex'); existing.lastAttempt = -Infinity;
        this.panels.set(symbol, existing);
        existing.panel.title = `${this.name(symbol) || symbol} · 行情`;
        existing.panel.webview.html = chartHtml(existing.panel.webview, this.context, symbol, existing.token, nextMode);
      } else if (requestedMode && nextMode !== existing.mode) {
        this.changeMode(existing, nextMode);
      }
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('welove42.aShareTurnover.stockChart', `${this.name(symbol) || symbol} · 行情`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    const state = { symbol, panel, mode: availableMode(symbol, requestedMode || defaultMode), token: randomBytes(24).toString('hex'), ready: false, visible: panel.visible, generation: 0, lastAttempt: -Infinity, abort: null, inflight: null, data: null };
    this.panels.set(symbol, state);
    state.listeners = [panel.webview.onDidReceiveMessage(message => this.receive(state, message)),
      panel.onDidDispose(() => this.close(state)),
      panel.onDidChangeViewState(() => {
        if (state.visible === panel.visible) return;
        state.visible = panel.visible;
        if (!panel.visible) this.cancel(state);
        else if (state.ready && !isWebMode(state.mode)) void this.refresh(state);
      })];
    panel.webview.html = chartHtml(panel.webview, this.context, symbol, state.token, state.mode);
  }
  send(state, message) {
    if (!this.disposed && this.panels.get(state.symbol) === state) void Promise.resolve(state.panel.webview.postMessage({ ...message, token: state.token })).catch(() => {});
  }
  visibleState() {
    // The title toolbar can be clicked in a visible but unfocused editor group.
    return this.disposed ? undefined : [...this.panels.values()].find(state => state.panel.visible);
  }
  changeMode(state, mode) {
    const next = availableMode(state.symbol, mode);
    if (state.mode !== next) { this.cancel(state); state.mode = next; state.data = null; state.lastAttempt = -Infinity; }
    if (state.ready) this.send(state, { type: 'select-mode', mode: next });
  }
  async chooseMode() {
    const state = this.visibleState();
    if (!state) return;
    const token = state.token;
    const items = [
      { mode: 'intraday', label: '分时图（内置）', detail: '分钟价格、成交量及技术指标，无需加载东方财富网页。' },
      ...MINUTE_MODES.map(mode => ({ mode, label: `${mode.slice(1)}分钟K线（内置）`, detail: '分钟开高低收、成交量、均线及技术指标。' })),
      { mode: 'daily', label: '日K图（内置）', detail: '日K、均线、成交量及技术指标，支持60 / 120 / 180根。' },
      { mode: 'weekly', label: '周K图（内置）', detail: '使用行情源周K，含均线、成交量及周线技术指标。' },
      { mode: 'monthly', label: '月K图（内置）', detail: '使用行情源月K，含均线、成交量及月线技术指标。' },
      { mode: 'eastmoney', label: '常规图表（东方财富）', detail: '网页支持更多周期；遇验证码可切换内置图表，或用右上角浏览器按钮打开。' },
      { mode: 'chips', label: '筹码盘口（东方财富）', detail: '买卖五档及“日K → 筹码分布”；遇验证码建议在浏览器打开并手动完成验证。' }
    ].filter(item => item.mode !== 'chips' || supportsChips(state.symbol))
      .map(item => ({ ...item, description: item.mode === state.mode ? '当前图表' : undefined }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `${this.name(state.symbol) || state.symbol} · 切换图表类型`,
      placeHolder: supportsChips(state.symbol) ? '选择图表类型' : '当前品种不支持筹码盘口，可选择常规图表或插件内图表',
      matchOnDetail: true
    });
    // A picker opened for the previous stock must not change a newly opened stock.
    if (picked && this.visibleState() === state && state.token === token) this.changeMode(state, picked.mode);
  }
  async chooseIndicator() {
    const state = this.visibleState(); if (!state) return;
    const token = state.token;
    const picked = await vscode.window.showQuickPick([
      { indicator: 'macd', label: 'MACD (12,26,9)', detail: 'DIF、DEA与红绿柱；默认显示。' },
      { indicator: 'kdj', label: 'KDJ (9,3,3)', detail: 'K、D、J三条曲线；分时使用分钟采样价格计算。' },
      { indicator: 'rsi', label: 'RSI (6,12,24)', detail: '6、12、24周期相对强弱曲线。' },
      { indicator: 'none', label: '隐藏技术指标', detail: '仅保留主图与成交量。' }
    ].map(item => ({ ...item, description: item.indicator === this.indicator ? '当前指标' : undefined })), {
      title: '切换内置副图指标', placeHolder: isWebMode(state.mode) ? '选择后切到内置分时图；网页指标由网站自身控制' : '指标按当前图表周期计算，切换不请求网络'
    });
    if (!picked || !INDICATORS.includes(picked.indicator) || this.visibleState() !== state || state.token !== token) return;
    this.indicator = picked.indicator;
    void Promise.resolve(this.context.globalState.update('chartIndicator', this.indicator)).catch(() => {});
    if (state.ready) this.send(state, { type: 'select-indicator', indicator: this.indicator });
    if (isWebMode(state.mode)) this.changeMode(state, 'intraday');
  }
  refreshActive() {
    const state = this.visibleState();
    if (!state) return;
    if (!state.ready) { state.pendingRefresh = true; return; }
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
    if (message.action === 'period' && state.ready && !isWebMode(state.mode)
      && ['intraday', ...MINUTE_MODES, 'daily', 'weekly', 'monthly'].includes(message.mode)) {
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
  cancel(state) { state.generation++; state.abort?.abort(); state.abort = null; state.inflight = null; }
  refresh(state, force = false) {
    if (this.disposed || !state.ready || !state.panel.visible || isWebMode(state.mode)) return Promise.resolve();
    if (state.inflight) return state.inflight;
    const key = `${state.symbol}:${state.mode}`, now = this.now().getTime(), cached = this.cache.get(key);
    if (!force && cached && now >= cached.at && now - cached.at < POLL_MS) {
      state.data = cached.data; state.lastAttempt = cached.at;
      this.send(state, { type: 'data', data: cached.data });
      return Promise.resolve();
    }
    // Repeated toolbar clicks must not create a request burst.
    if (force && now - state.lastAttempt < 2000) return Promise.resolve();
    const generation = state.generation, mode = state.mode, abort = state.abort = new AbortController();
    state.lastAttempt = this.now().getTime();
    this.send(state, { type: 'loading', mode, preserve: Boolean(state.data) });
    state.inflight = (async () => {
      try {
        const data = await this.provider.load(state.symbol, mode, abort.signal);
        if (this.disposed || abort.signal.aborted || state.generation !== generation) return;
        state.data = data;
        this.cache.delete(key); this.cache.set(key, { data, at: state.lastAttempt });
        if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
        if (data.name) state.panel.title = `${data.name} · 行情`;
        this.send(state, { type: 'data', data });
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted && state.generation === generation) this.send(state, { type: 'error', mode, message: error.message || '图表获取失败', preserve: Boolean(state.data) });
      } finally {
        if (state.generation === generation) { state.inflight = null; state.abort = null; }
      }
    })();
    return state.inflight;
  }
  tick() {
    if (this.disposed) return;
    const extra = vscode.workspace.getConfiguration('aShareTurnover').get('additionalClosedDates', []);
    if (!session(this.now(), extra).polling) return;
    for (const state of this.panels.values()) if (state.ready && !isWebMode(state.mode) && state.panel.visible && !state.inflight && this.now().getTime() - state.lastAttempt >= POLL_MS) void this.refresh(state);
  }
  async openExternal(element, mode) {
    try {
      const symbol = this.resolve(element);
      return await vscode.env.openExternal(vscode.Uri.parse(isWebMode(mode) ? eastmoneyChartUrl(symbol, mode) : eastmoneyUrl(symbol)));
    }
    catch (e) { return vscode.window.showErrorMessage(e.message); }
  }
  getState(symbol) {
    const state = this.panels.get(symbol);
    return state ? { symbol, mode: state.mode, indicator: this.indicator, ready: Boolean(state.ready), date: state.data?.date, bars: state.data?.bars?.length || 0 } : undefined;
  }
  close(state) {
    this.cancel(state);
    for (const listener of state.listeners) listener.dispose();
    if (this.panels.get(state.symbol) === state) this.panels.delete(state.symbol);
  }
  dispose() {
    this.disposed = true; clearInterval(this.timer);
    this.cache.clear();
    for (const state of [...this.panels.values()]) { this.close(state); state.panel.dispose(); }
  }
}
module.exports = { ChartController, chartHtml };
