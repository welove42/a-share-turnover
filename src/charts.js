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
<header><div class="identity"><strong id="name">${escapeHtml(symbol)}</strong><span id="quote"></span></div>
<nav aria-label="图表类型"><button data-mode="eastmoney" aria-pressed="${mode === 'eastmoney'}">常规图表</button><button data-mode="chips" aria-pressed="${mode === 'chips'}"${chipsUrl ? '' : ' disabled title="筹码盘口仅支持沪深A股个股；当前品种请使用常规图表"'}>筹码盘口</button><button data-mode="intraday" aria-pressed="${mode === 'intraday'}">分时图</button><button data-mode="daily" aria-pressed="${mode === 'daily'}">日K图</button><span class="spacer"></span><button id="refresh">刷新</button><button id="external">浏览器打开 ↗</button></nav>
<p id="hint">东方财富专用图表；点击其他个股会在此标签切换。若页面空白，可使用插件内分时、日K图或在浏览器打开。</p></header>
<main><div id="web-chart"${isWebMode(mode) ? '' : ' hidden'}><iframe id="eastmoney" title="东方财富 ${escapeHtml(symbol)} 专用图表"${isWebMode(mode) ? ` src="${escapeHtml(url)}"` : ''} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>
<section id="local" hidden aria-label="插件内行情图表"><div class="chart-tools"><span id="meta"></span><label id="range-label" hidden>显示 <select id="range"><option value="60">60日</option><option value="120">120日</option><option value="180" selected>180日</option></select></label></div>
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
        existing.symbol = symbol; existing.mode = nextMode; existing.data = null; existing.ready = false;
        existing.token = randomBytes(24).toString('hex'); existing.lastAttempt = -Infinity;
        this.panels.set(symbol, existing);
        existing.panel.title = `${this.name(symbol) || symbol} · 行情`;
        existing.panel.webview.html = chartHtml(existing.panel.webview, this.context, symbol, existing.token, nextMode);
      } else if (requestedMode && nextMode !== existing.mode) {
        this.cancel(existing); existing.mode = nextMode; existing.data = null;
        if (existing.ready) this.send(existing, { type: 'select-mode', mode: nextMode });
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
  receive(state, message) {
    if (this.disposed || this.panels.get(state.symbol) !== state || !message || message.token !== state.token) return;
    if (message.action === 'external') return this.openExternal(state.symbol, state.mode);
    if (message.action === 'ready') {
      state.ready = true;
      this.send(state, { type: 'title', name: this.name(state.symbol) || state.symbol });
      this.send(state, { type: 'select-mode', mode: state.mode });
    } else if (message.action === 'mode' && state.ready && MODES.includes(message.mode)) {
      const mode = availableMode(state.symbol, message.mode);
      if (state.mode !== mode) { this.cancel(state); state.mode = mode; state.data = null; }
      if (mode !== message.mode) this.send(state, { type: 'select-mode', mode });
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
