'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { normalizeSymbol, INDEX_SYMBOL } = require('./quotes');
const { POLL_MS, session } = require('./market');
const { ChartProvider, eastmoneyUrl, eastmoneyChartUrl, supportsChips } = require('./chart-data');

const MODES = ['eastmoney', 'chips', 'intraday', 'daily'];
const isWebMode = mode => mode === 'eastmoney' || mode === 'chips';
const availableMode = (symbol, mode) => MODES.includes(mode) && (mode !== 'chips' || supportsChips(symbol)) ? mode : 'eastmoney';

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function chartHtml(webview, context, symbol, token, mode = 'eastmoney') {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.js'));
  mode = availableMode(symbol, mode);
  const regularUrl = eastmoneyChartUrl(symbol), chipsUrl = supportsChips(symbol) ? eastmoneyChartUrl(symbol, 'chips') : '';
  const url = mode === 'chips' ? chipsUrl : regularUrl, nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src https://quote.eastmoney.com; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${escapeHtml(css)}"><title>${escapeHtml(symbol)} 行情图表</title></head>
<body data-symbol="${escapeHtml(symbol)}" data-token="${token}" data-regular-url="${escapeHtml(regularUrl)}" data-chips-url="${escapeHtml(chipsUrl)}" data-mode="${escapeHtml(mode)}">
<main><div id="web-chart"${isWebMode(mode) ? '' : ' hidden'}><iframe id="eastmoney" title="东方财富 ${escapeHtml(symbol)} 专用图表"${isWebMode(mode) ? ` src="${escapeHtml(url)}"` : ''} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>
<section id="local" hidden aria-label="插件内行情图表"><div class="chart-tools"><span id="quote"></span><label id="range-label" hidden>显示 <select id="range"><option value="60">60日</option><option value="120">120日</option><option value="180" selected>180日</option></select></label></div><p id="meta"></p>
<p id="status" role="status" aria-live="polite"></p><div id="plot" tabindex="0" role="img" aria-label="行情价格及成交量图"><svg id="svg" viewBox="0 0 1040 550" aria-hidden="true"></svg></div><p id="detail">移动鼠标查看价格与成交量。</p>
<p class="note">分时为分钟价格，柱形为每分钟成交量；日K包含开高低收及 MA5 / MA10 / MA20。成交量单位：手。数据时间均为北京时间。插件内图表仅在可见且交易期间每10秒刷新；第三方网页按网站自身规则更新。</p></section></main>
<script nonce="${nonce}" src="${escapeHtml(js)}"></script></body></html>`;
}

class ChartController {
  constructor(context, { provider = new ChartProvider(), now = () => new Date(), selected = () => INDEX_SYMBOL, name = () => undefined } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.selected = selected; this.name = name;
    this.panels = new Map(); this.disposed = false;
    this.timer = setInterval(() => this.tick(), 1000);
  }
  resolve(element) { return normalizeSymbol(typeof element === 'string' ? element : element?.symbol || this.selected()); }
  async open(element, mode) {
    if (this.disposed) return;
    let symbol;
    try { symbol = this.resolve(element); } catch (e) { return vscode.window.showErrorMessage(e.message); }
    const requestedMode = MODES.includes(mode) ? mode : undefined;
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
    const state = { symbol, panel, mode: availableMode(symbol, requestedMode), token: randomBytes(24).toString('hex'), ready: false, visible: panel.visible, generation: 0, lastAttempt: -Infinity, abort: null, inflight: null, data: null };
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
    if (state.mode !== next) { this.cancel(state); state.mode = next; state.data = null; }
    if (state.ready) this.send(state, { type: 'select-mode', mode: next });
  }
  async chooseMode() {
    const state = this.visibleState();
    if (!state) return;
    const token = state.token;
    const items = [
      { mode: 'eastmoney', label: '常规图表', detail: '东方财富：分时、日K及其他周期，网页自动更新。' },
      { mode: 'chips', label: '筹码盘口', detail: '东方财富：买卖五档、分时与K线；网页内选择“日K → 筹码分布”。' },
      { mode: 'intraday', label: '分时图', detail: '插件内分钟价格与成交量；网页空白时可切换使用。' },
      { mode: 'daily', label: '日K图', detail: '插件内日K、均线与成交量，支持60 / 120 / 180日范围。' }
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
  refreshActive() {
    const state = this.visibleState();
    if (!state) return;
    if (!state.ready) { state.pendingRefresh = true; return; }
    if (isWebMode(state.mode)) this.send(state, { type: 'refresh', mode: state.mode });
    else return this.refresh(state);
  }
  openActiveExternal() {
    const state = this.visibleState();
    if (state) return this.openExternal(state.symbol, state.mode);
  }
  receive(state, message) {
    if (this.disposed || this.panels.get(state.symbol) !== state || !message || message.token !== state.token) return;
    if (message.action === 'external') return this.openExternal(state.symbol, state.mode);
    if (message.action === 'ready') {
      state.ready = true;
      this.send(state, { type: 'select-mode', mode: state.mode });
      if (state.pendingRefresh) {
        state.pendingRefresh = false;
        if (isWebMode(state.mode)) this.send(state, { type: 'refresh', mode: state.mode });
      }
    } else if (message.action === 'mode-ready' && state.ready && message.mode === state.mode) {
      if (!isWebMode(state.mode)) return this.refresh(state);
    } else if (message.action === 'refresh' && state.ready && !isWebMode(state.mode)) return this.refresh(state);
  }
  cancel(state) { state.generation++; state.abort?.abort(); state.abort = null; state.inflight = null; }
  refresh(state) {
    if (this.disposed || !state.ready || !state.panel.visible || isWebMode(state.mode)) return Promise.resolve();
    if (state.inflight) return state.inflight;
    const generation = state.generation, mode = state.mode, abort = state.abort = new AbortController();
    state.lastAttempt = this.now().getTime();
    this.send(state, { type: 'loading', mode, preserve: Boolean(state.data) });
    state.inflight = (async () => {
      try {
        const data = await this.provider.load(state.symbol, mode, abort.signal);
        if (this.disposed || abort.signal.aborted || state.generation !== generation) return;
        state.data = data;
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
    return state ? { symbol, mode: state.mode, ready: Boolean(state.ready), date: state.data?.date, bars: state.data?.bars?.length || 0 } : undefined;
  }
  close(state) {
    this.cancel(state);
    for (const listener of state.listeners) listener.dispose();
    if (this.panels.get(state.symbol) === state) this.panels.delete(state.symbol);
  }
  dispose() {
    this.disposed = true; clearInterval(this.timer);
    for (const state of [...this.panels.values()]) { this.close(state); state.panel.dispose(); }
  }
}
module.exports = { ChartController, chartHtml };
