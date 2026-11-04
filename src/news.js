'use strict';
const vscode = require('vscode');
const { shanghaiClock } = require('./market');
const { SOURCES, isArticle, mergeNews, NewsProvider } = require('./news-data');
function articleText(item) {
  const c = shanghaiClock(new Date(item.publishedAt));
  return `${item.title}\n\n来源：${SOURCES[item.source]}　${c.date} ${c.time}（北京）\n\n${item.body}${item.stocks ? '\n\n相关股票：' + item.stocks : ''}\n`;
}
function articleOutput(item) {
  const c = shanghaiClock(new Date(item.publishedAt));
  return `📣 ${item.title}\n📄 摘要：${item.body}${item.stocks ? '\n📈 相关股票：' + item.stocks : ''}\n🕒 时间：${c.date} ${c.time}（北京）　来源：${SOURCES[item.source]}\n────────────────────────────────`;
}
class NewsController {
  constructor(context, { provider = new NewsProvider(), now = () => new Date(), log = () => {} } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.log = log;
    // Retire only this extension's old news credential; never read or send it.
    void context.secrets.delete('aShareTurnover.xuangubaoToken').catch(() => this.log('旧版新闻凭证清理失败，下次启动时重试。'));
    this.disposed = false; this.inflight = null; this.abort = null; this.lastAttempt = -Infinity; this.generation = 0;
    this.items = []; this.unread = 0; this.loaded = false; this.error = ''; this.lastSignature = '';
    this.documents = new Map(); this.outputKeys = new Set(); this.paused = Boolean(context.globalState.get('newsPaused', false));
    this.config = this.readConfig();
    const saved = context.globalState.get('newsCache');
    if (saved?.source === this.config.source && Array.isArray(saved.items)) this.items = saved.items.filter(isArticle).slice(0, 200);
    this.status = vscode.window.createStatusBarItem('aShareTurnover.news', vscode.StatusBarAlignment.Right, 98);
    this.status.name = '财经快讯'; this.status.command = 'welove42.aShareTurnover.news.show'; this.statusRendered = {}; this.statusVisible = false;
    this.output = vscode.window.createOutputChannel('财经新闻7×24资讯');
    this.documentProvider = vscode.workspace.registerTextDocumentContentProvider('a-share-news', {
      provideTextDocumentContent: uri => this.documents.get(uri.path) || '该快讯已过期，请刷新列表后重新打开。'
    });
    this.listener = vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('aShareTurnover.news')) return;
      this.config = this.readConfig();
      this.generation++; this.abort?.abort();
      this.publish();
      if (this.config.enabled && !this.paused) void (this.inflight || Promise.resolve()).then(() => {
        if (!this.disposed && this.config.enabled && !this.paused) return this.refresh();
      });
    });
  }
  readConfig() {
    const c = vscode.workspace.getConfiguration('aShareTurnover');
    const seconds = Number(c.get('news.refreshIntervalSeconds', 30));
    // Ignore the retired news.source setting, including existing xuangubao selections.
    return { enabled: c.get('news.enabled', true), source: 'eastmoney',
      interval: Math.max(10, Math.min(300, Number.isFinite(seconds) ? seconds : 30)) * 1000 };
  }
  start() {
    this.publish();
    this.timer = setInterval(() => {
      if (this.config.enabled && !this.paused && this.now().getTime() - this.lastAttempt >= this.config.interval) void this.refresh();
    }, 1000);
    if (this.config.enabled && !this.paused) void this.refresh();
  }
  publish() {
    if (this.disposed) return;
    if (this.hidden) { if (this.statusVisible) { this.status.hide(); this.statusVisible = false; } return; }
    if (this.error && this.error !== this.lastError) this.output.appendLine(`⚠ ${this.error}${this.items.length ? '。保留上次成功快讯。' : ''}`);
    this.lastError = this.error;
    if (!this.config.enabled) { if (this.statusVisible) { this.status.hide(); this.statusVisible = false; } return; }
    const text = `$(megaphone) 新闻${this.unread ? ` (${this.unread})` : ''}${this.paused ? ' · 暂停' : this.error ? ' $(warning)' : ''}`;
    const tooltip = `${SOURCES[this.config.source]}财经快讯，${this.config.interval / 1000} 秒刷新\n点击打开资讯输出面板${this.error ? '\n' + this.error : ''}`;
    if (this.statusRendered.text !== text) this.status.text = text;
    if (this.statusRendered.tooltip !== tooltip) this.status.tooltip = tooltip;
    this.statusRendered = { text, tooltip };
    if (!this.statusVisible) { this.status.show(); this.statusVisible = true; }
  }
  refresh() {
    if (this.disposed || this.hidden || !this.config.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const generation = this.generation, source = this.config.source;
    const abort = this.abort = new AbortController(); this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      try {
        if (abort.signal.aborted || this.disposed) return;
        const articles = await this.provider.load(abort.signal);
        if (this.disposed || abort.signal.aborted || generation !== this.generation) return;
        const merged = mergeNews(this.items, articles);
        const output = this.loaded ? merged.added : articles;
        this.appendOutput(output);
        if (this.loaded) this.unread = Math.min(999, this.unread + merged.added.length);
        this.items = merged.items; this.loaded = true; this.error = '';
        await this.context.globalState.update('newsCache', { source, items: this.items }).catch(() => {});
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) { this.error = error.message || '新闻请求失败'; this.log(`财经新闻：${this.error}`); }
      } finally {
        this.inflight = null; this.abort = null; if (!this.disposed) this.publish();
      }
    })();
    return this.inflight;
  }
  markRead() { this.unread = 0; this.publish(); }
  appendOutput(articles) {
    for (const article of [...articles].sort((a, b) => a.publishedAt - b.publishedAt)) {
      if (this.outputKeys.has(article.key)) continue;
      this.output.appendLine(articleOutput(article));
      this.outputKeys.add(article.key);
      if (this.outputKeys.size > 2000) this.outputKeys.delete(this.outputKeys.values().next().value);
    }
  }
  show() {
    // Keep append-only output readable without replacing its contents or scrolling on each poll.
    if (!this.loaded && this.items.length) {
      if (!this.outputKeys.size) this.output.appendLine('以下为上次缓存内容，等待最新快讯。');
      this.appendOutput(this.items);
    }
    this.output.show(true); this.markRead();
  }
  async open(article) {
    const known = this.items.find(item => item.key === article?.key);
    if (!known) return;
    const path = `/${known.key}.txt`; this.documents.set(path, articleText(known));
    // Bound virtual document storage independently from retained news.
    if (this.documents.size > 200) this.documents.delete(this.documents.keys().next().value);
    this.markRead();
    return vscode.window.showTextDocument(vscode.Uri.from({ scheme: 'a-share-news', path }), { preview: true, preserveFocus: false });
  }
  async togglePause() {
    this.paused = !this.paused; if (this.paused) this.abort?.abort();
    await this.context.globalState.update('newsPaused', this.paused); this.publish();
    if (!this.paused) { if (this.inflight) await this.inflight; return this.refresh(); }
  }
  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) { this.generation++; this.abort?.abort(); this.output.hide(); }
    this.publish();
    if (!hidden && !this.paused && this.config.enabled) void (this.inflight || Promise.resolve()).then(() => { if (!this.disposed && !this.hidden && !this.paused && this.config.enabled) return this.refresh(); });
  }
  dispose() {
    this.disposed = true; clearInterval(this.timer); this.abort?.abort();
    for (const resource of [this.listener, this.documentProvider, this.status, this.output]) resource.dispose();
  }
}
module.exports = { NewsController, articleText, articleOutput };
