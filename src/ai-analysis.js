'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const privateUI = require('./privacy-ui');
const { endpoint, modelName, secretId, complete } = require('./ai-client');
const { AnalysisContext, SYSTEM } = require('./ai-context');
const VIEW = 'welove42.aShareTurnover.aiAnalysis';
const PHASES = { connecting: '正在连接 AI 服务…', waiting: '等待模型回复…', reasoning: '模型正在思考，尚未返回正文…', answering: '正在接收分析…' };
function readConfig() {
  const config = vscode.workspace.getConfiguration('aShareTurnover');
  // Ignore workspace overrides: a repository must never redirect a stored key.
  const read = key => config.inspect ? config.inspect(key)?.globalValue ?? config.inspect(key)?.defaultValue ?? '' : config.get(key, '');
  return { url: read('ai.baseUrl'), model: read('ai.model') };
}
function html(webview, context, token) {
  const uri = name => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${uri('ai-analysis.css')}"><title>AI 分析</title></head><body data-token="${token}"><header><div><strong>AI 分析</strong><span id="model"></span></div><button id="settings" class="quiet" title="配置 API 地址、模型和密钥">设置</button></header><section class="target"><button id="choose" class="target-button" title="选择自选股或大盘"><span id="target">选择分析对象</span><span aria-hidden="true">⌄</span></button><div class="toolbar"><button id="analyze">开始分析</button><button id="stop" class="secondary" hidden>停止</button><button id="clear" class="quiet">清空</button></div></section><p id="status" role="status" aria-live="polite"></p><p id="context-summary" hidden aria-label="分析上下文"></p><main id="conversation" tabindex="0" aria-label="分析内容"><div id="welcome"><h2>边写代码，边看分析</h2><p>选择个股、场内 ETF 或大盘，自动带入个股、大盘、所属板块、全球市场及财经快讯。</p><p>首次使用，在设置中填写 API 地址、模型和 Key。</p><p class="muted">仅点击分析、追问或测试连接时调用，由你的 API 服务商计费。</p></div><div id="messages"></div></main><details id="snapshot" hidden><summary>本次行情数据</summary><pre id="data"></pre></details><form id="followup"><label for="question">继续追问</label><div class="composer"><textarea id="question" rows="2" maxlength="2000" placeholder="例如：目前有哪些风险？"></textarea><button id="send" type="submit">发送</button></div></form><footer>仅发送公开行情、快讯和本次对话，不读取代码或持仓。<br>AI 可能有误，分析仅供参考。</footer><script nonce="${nonce}" src="${uri('ai-analysis.js')}"></script></body></html>`;
}
class AiAnalysisController {
  constructor(context, { stocks, market, globals, commodities, news, collect, request = complete, config = readConfig, openSettings = () => {} } = {}) {
    Object.assign(this, { context, stocks, request, config, openSettings });
    const source = collect ? null : new AnalysisContext({ stocks, market, globals, commodities, news });
    this.collect = collect || ((target, signal) => source.collect(target, signal));
    this.messages = []; this.history = []; this.status = ''; this.generation = 0; this.busy = false; this.configured = false;
    this.registration = vscode.window.registerWebviewViewProvider(VIEW, this);
    this.listener = vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('aShareTurnover.ai')) return;
      this.stop(); this.history = []; this.messages = []; this.snapshot = null;
      this.status = '配置已更新，点击开始分析。'; void this.updateConfiguration();
    });
    this.ready = this.updateConfiguration();
  }
  async updateConfiguration() {
    const revision = (this.configRevision || 0) + 1; this.configRevision = revision;
    let configured = false, keyConfigured = false, keyEndpoint = '';
    try { const c = this.config(); keyEndpoint = endpoint(c.url); keyConfigured = Boolean(await this.context.secrets.get(secretId(c.url))); modelName(c.model); configured = keyConfigured; } catch { /* Empty setup. */ }
    if (revision !== this.configRevision || this.disposed) return;
    this.configured = configured; this.keyConfigured = keyConfigured; this.keyEndpoint = keyEndpoint; this.publish();
  }
  resolveWebviewView(view) {
    this.view = view; this.token = randomBytes(24).toString('hex');
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = this.hidden ? '' : html(view.webview, this.context, this.token);
    const token = this.token;
    view.webview.onDidReceiveMessage(message => {
      if (this.hidden || this.disposed || this.view !== view || message?.token !== token) return;
      if (message.type === 'ready') this.publish();
      else if (message.type === 'settings') this.openSettings();
      else if (message.type === 'choose') void this.choose();
      else if (message.type === 'analyze') void this.analyze();
      else if (message.type === 'stop') this.stop();
      else if (message.type === 'clear') this.clear();
      else if (message.type === 'ask' && typeof message.text === 'string') void this.analyze(message.text);
    });
    view.onDidDispose(() => { if (this.view === view) { this.stop(); this.view = null; } });
  }
  publish() {
    if (this.hidden || this.disposed || !this.view) return;
    void this.view.webview.postMessage({ type: 'state', token: this.token, target: this.target, name: this.name(), model: this.config().model,
      configured: this.configured, busy: this.busy, status: this.status, messages: this.messages, snapshot: this.snapshot, canAsk: this.history.length > 0 });
  }
  name() { return this.target === 'market' ? '沪深大盘' : this.target ? `${this.stocks?.quotes.get(this.target)?.name || this.snapshot?.quote?.name || this.target} · ${this.target}` : '选择分析对象'; }
  async open(target) {
    if (this.hidden || this.disposed) return;
    const symbol = typeof target === 'string' ? target : target?.symbol;
    const intent = this.openIntent = (this.openIntent || 0) + 1;
    await vscode.commands.executeCommand(`${VIEW}.focus`);
    if (this.hidden || this.disposed || intent !== this.openIntent) return;
    if (symbol && (symbol === 'market' || /^(?:sh|sz|bj)\d{6}$/.test(symbol))) { this.clear(); this.target = symbol; return this.analyze(); }
    if (!this.target) return this.choose();
    this.publish();
  }
  async choose() {
    if (this.hidden || this.disposed) return;
    const selected = await privateUI.showQuickPick([{ label: '沪深大盘', symbol: 'market' }, ...(this.stocks?.config.symbols || []).map(symbol => ({ label: this.stocks?.quotes.get(symbol)?.name || symbol, description: symbol, symbol }))], { title: 'AI 分析', placeHolder: '选择个股、场内 ETF 或大盘' });
    if (!selected || this.hidden || this.disposed) return;
    this.clear(); this.target = selected.symbol; return this.analyze();
  }
  stop() {
    this.generation++; this.abort?.abort(); this.abort = null; clearTimeout(this.publishTimer);
    this.publishTimer = null; clearInterval(this.progressTimer); this.progressTimer = null;
    if (this.pendingAnswer) { this.pendingAnswer.state = 'stopped'; this.pendingAnswer.notice = '已停止分析；可点击重新分析。'; this.pendingAnswer = null; }
    if (this.busy) this.status = '已停止；未完成的回复不用于追问。';
    this.busy = false; this.publish();
  }
  clear() { this.stop(); this.messages = []; this.history = []; this.snapshot = null; this.status = ''; this.publish(); }
  async analyze(question) {
    if (this.hidden || this.disposed || this.busy) return;
    const followup = typeof question === 'string';
    if (followup && (!question.trim() || question.length > 2000 || !this.history.length)) return;
    if (followup && this.history.length >= 20) { this.status = '本次对话已达 10 轮，请重新分析后继续。'; this.publish(); return; }
    if (!this.target) return this.choose();
    this.stop();
    const generation = this.generation, abort = this.abort = new AbortController();
    const active = () => generation === this.generation && !abort.signal.aborted && !this.hidden && !this.disposed;
    this.busy = true; this.status = '正在检查配置…'; this.publish();
    try {
      const c = this.config();
      let url, model, key;
      try { url = endpoint(c.url); model = modelName(c.model); key = await this.context.secrets.get(secretId(url)); } catch { /* Setup hint below. */ }
      if (!active()) return;
      if (!url || !model || !key) { this.configured = false; this.status = '请先在设置 → AI 分析中填写 API 地址、模型，并设置 API Key。'; return; }
      this.configured = true;
      if (!followup) {
        this.messages = []; this.history = []; this.snapshot = null; this.status = '正在汇总个股、大盘、所属板块、全球市场和财经快讯…'; this.publish();
        const snapshot = await this.collect(this.target, abort.signal);
        if (!active()) return;
        this.snapshot = snapshot;
      }
      const content = followup ? question.trim() : '请分析这份行情快照：\n' + JSON.stringify(this.snapshot);
      const prior = followup ? this.history : [];
      const user = { role: 'user', content }, answer = { role: 'assistant', content: '', state: 'pending', phase: 'connecting', elapsedSeconds: 0 };
      const requestMessages = [{ role: 'system', content: SYSTEM }, ...prior, user];
      if (JSON.stringify(requestMessages).length > 100000) throw new Error('本次对话过长，请重新分析后继续。');
      this.messages.push({ role: 'user', content: followup ? question.trim() : `分析 ${this.name()}` }, answer);
      this.pendingAnswer = answer; this.status = PHASES.connecting; this.publish();
      const started = Date.now();
      this.progressTimer = setInterval(() => {
        if (!active()) return;
        answer.elapsedSeconds = Math.floor((Date.now() - started) / 1000); this.publish();
      }, 1000);
      const result = await this.request({ url, model, key, messages: requestMessages, maxTokens: 3000, signal: abort.signal, onProgress: phase => {
        if (!active() || !PHASES[phase]) return;
        answer.phase = phase; this.status = PHASES[phase]; this.publish();
      }, onDelta: text => {
        if (!active()) return;
        answer.phase = 'answering'; this.status = PHASES.answering;
        answer.content += text;
        if (!this.publishTimer) this.publishTimer = setTimeout(() => { this.publishTimer = null; if (active()) this.publish(); }, 80);
      } });
      if (!active()) return;
      if (typeof result !== 'string' || !result.trim()) throw new Error('AI 未返回分析正文，请重试或更换模型。');
      answer.state = 'complete'; this.pendingAnswer = null;
      answer.content = result; this.history = [...prior, user, { role: 'assistant', content: result }];
      this.status = '分析完成 · 追问沿用本次行情，重新分析获取新数据';
    } catch (error) {
      if (active()) {
        this.status = error.message || '分析失败，请重试。';
        if (this.pendingAnswer) { this.pendingAnswer.state = 'error'; this.pendingAnswer.notice = this.status; this.pendingAnswer = null; }
      }
    }
    finally {
      if (active()) {
        this.busy = false; this.abort = null; clearTimeout(this.publishTimer); this.publishTimer = null;
        clearInterval(this.progressTimer); this.progressTimer = null; this.publish();
      }
    }
  }
  async saveKey(value, expectedUrl) {
    if (this.hidden || this.disposed) throw new Error('操作已取消');
    const url = endpoint(this.config().url);
    if (endpoint(expectedUrl) !== url) throw new Error('API 地址已变化，请重新保存。');
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\r\n]/.test(value)) throw new Error('请输入有效的 API Key。');
    this.stop();
    try { await this.context.secrets.store(secretId(url), value.trim()); } catch { throw new Error('API Key 保存失败，请重试。'); }
    await this.updateConfiguration();
  }
  async clearKey(expectedUrl = this.config().url) {
    if (this.hidden || this.disposed) throw new Error('操作已取消');
    const url = endpoint(this.config().url);
    if (endpoint(expectedUrl) !== url) throw new Error('请先保存 API 地址，再清除对应的 Key。');
    this.stop();
    try { await this.context.secrets.delete(secretId(url)); } catch { throw new Error('API Key 清除失败，请重试。'); }
    await this.updateConfiguration();
  }
  async testConnection({ signal, onProgress = () => {}, expectedUrl, expectedModel } = {}) {
    const cancelled = () => { const e = new Error('连接测试已取消。'); e.name = 'AbortError'; return e; };
    if (this.hidden || this.disposed || signal?.aborted) throw cancelled();
    this.stop(); const generation = this.generation, abort = this.abort = new AbortController();
    const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true });
    const active = () => !this.hidden && !this.disposed && !abort.signal.aborted && generation === this.generation;
    this.busy = true; this.status = '正在测试连接…'; this.publish();
    try {
      const c = this.config(), url = endpoint(c.url), model = modelName(c.model), key = await this.context.secrets.get(secretId(url));
      if (!active()) throw cancelled();
      if (expectedUrl && endpoint(expectedUrl) !== url || expectedModel && expectedModel !== model) throw new Error('配置已变化，请重新测试。');
      const result = await this.request({ url, model, key, messages: [{ role: 'user', content: '请只回复：连接成功' }], signal: abort.signal, maxTokens: 64,
        onProgress: phase => { if (active()) onProgress(phase); } });
      if (!active()) throw cancelled();
      if (typeof result !== 'string' || !result.trim()) throw new Error('AI 未返回测试回复，请检查模型或重试。');
      this.status = '连接成功，可以开始分析。';
      return { ok: true, model };
    } catch (error) {
      if (!active()) error = cancelled();
      if (!this.hidden && !this.disposed && generation === this.generation) this.status = error.message || '连接测试失败，请重试。';
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); if (generation === this.generation) { this.busy = false; this.abort = null; this.publish(); } }
  }
  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) { this.openIntent = (this.openIntent || 0) + 1; this.clear(); this.target = undefined; if (this.view) this.view.webview.html = ''; }
    else if (this.view) { this.view.webview.html = html(this.view.webview, this.context, this.token); this.publish(); }
  }
  dispose() { this.disposed = true; this.stop(); this.listener.dispose(); this.registration.dispose(); }
}
module.exports = { AiAnalysisController, VIEW, html, readConfig };
