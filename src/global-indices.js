'use strict';
const vscode = require('vscode');
const { POLL_MS, shanghaiClock } = require('./market');
const { signed, percentText } = require('./quotes');
const { REGIONS, ALIASES, DEFAULT_INDICES, isGlobalQuote, GlobalIndexProvider, globalIndexUrl } = require('./global-index-data');

function quoteTime(q) {
  if (!q) return '尚未获取';
  const clock = shanghaiClock(new Date(q.timestamp * 1000));
  return `${clock.date} ${clock.time}`;
}
class GlobalIndicesController {
  constructor(context, { provider = new GlobalIndexProvider(), now = () => new Date(), log = () => {} } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.log = log;
    this.catalog = new Map(DEFAULT_INDICES.map(entry => [entry.id, entry]));
    this.quotes = new Map(); this.errors = new Map(); this.elements = new Map(); this.signatures = new Map();
    this.groups = new Map(REGIONS.map(region => [region.id, { kind: 'region', region: region.id }]));
    this.disposed = false; this.inflight = null; this.abort = null; this.generation = 0; this.lastAttempt = -Infinity; this.cached = true;
    this.paused = Boolean(context.globalState.get('globalIndicesPaused', false));
    const cache = context.globalState.get('globalIndexQuotes', []);
    if (Array.isArray(cache)) for (const q of cache) if (isGlobalQuote(q)) { this.quotes.set(q.id, q); this.catalog.set(q.id, { id: q.id, code: q.code, name: q.name, region: q.region }); }
    this.enabled = this.readEnabled();
    this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView('welove42.aShareTurnover.globalIndices', { treeDataProvider: this, showCollapseAll: true });
    this.listeners = [this.tree.onDidChangeVisibility(event => {
      this.publish();
      if (!event.visible) this.abort?.abort();
      else if (this.enabled && !this.paused) void this.refresh(true);
    }), vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('aShareTurnover.globalIndices')) return;
      this.enabled = this.readEnabled(); this.generation++; this.abort?.abort(); this.publish(true);
      if (this.enabled && !this.paused && this.tree.visible) void this.refresh(true);
    })];
  }
  readEnabled() { return vscode.workspace.getConfiguration('aShareTurnover').get('globalIndices.enabled', true); }
  start() {
    this.publish(true); this.timer = setInterval(() => void this.tick(), 1000);
    if (this.enabled && !this.paused) void this.refresh();
  }
  tick() {
    if (!this.disposed && this.enabled && !this.paused && this.tree.visible && !this.inflight && this.now().getTime() - this.lastAttempt >= POLL_MS) return this.refresh(true);
  }
  entries(region) {
    return [...this.catalog.values()].filter(entry => !region || entry.region === region).sort((a, b) => {
      const regionOrder = REGIONS.findIndex(item => item.id === a.region) - REGIONS.findIndex(item => item.id === b.region);
      if (regionOrder) return regionOrder;
      const codes = REGIONS.find(item => item.id === a.region)?.codes || [];
      return codes.indexOf(a.code) - codes.indexOf(b.code) || a.name.localeCompare(b.name, 'zh-CN');
    });
  }
  getChildren(element) {
    if (!this.enabled) return [];
    if (!element) return REGIONS.filter(region => this.entries(region.id).length).map(region => this.groups.get(region.id));
    return element.kind === 'region' ? this.entries(element.region).map(entry => this.element(entry.id)) : [];
  }
  element(id) {
    if (!this.elements.has(id)) this.elements.set(id, { kind: 'globalIndex', id });
    return this.elements.get(id);
  }
  getParent(element) { return element.kind === 'globalIndex' ? this.groups.get(this.catalog.get(element.id)?.region) : undefined; }
  getTreeItem(element) {
    if (element.kind === 'region') {
      const region = REGIONS.find(item => item.id === element.region);
      const item = new vscode.TreeItem(`${region.name} (${this.entries(region.id).length})`, region.id === 'asia' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `global-region:${region.id}`; item.iconPath = new vscode.ThemeIcon('globe'); return item;
    }
    const entry = this.catalog.get(element.id), q = this.quotes.get(element.id), error = this.errors.get(element.id);
    const item = new vscode.TreeItem(`${percentText(q?.percent ?? null).padStart(7)}   ${(q ? q.price.toFixed(2) : '—').padStart(9)}   [${entry.name}]`, vscode.TreeItemCollapsibleState.None);
    item.id = `global-index:${entry.id}`; item.contextValue = 'aShareGlobalIndex';
    item.description = `${error ? '获取失败 · ' : this.cached && q ? '缓存 · ' : ''}${q ? quoteTime(q).slice(5, 16) : '待获取'}`;
    item.iconPath = error ? new vscode.ThemeIcon('warning') : new vscode.ThemeIcon(q?.percent > 0 ? 'chevron-up' : q?.percent < 0 ? 'chevron-down' : 'dash',
      q?.percent > 0 ? new vscode.ThemeColor('charts.red') : q?.percent < 0 ? new vscode.ThemeColor('charts.green') : undefined);
    item.command = { command: 'welove42.aShareTurnover.globalIndices.open', title: '在浏览器查看指数详情', arguments: [entry.id] };
    const tip = new vscode.MarkdownString(); tip.isTrusted = false; tip.supportHtml = false;
    tip.appendText(`${entry.name}（${entry.code}）\n\n地区：${REGIONS.find(region => region.id === entry.region).name}\n指数点位：${q ? q.price.toFixed(2) : '—'}　涨跌幅：${percentText(q?.percent ?? null)}\n涨跌点数：${signed(q?.delta ?? null, 2)}\n今开：${q?.open ?? '—'}　昨收：${q?.previousClose ?? '—'}\n最高：${q?.high ?? '—'}　最低：${q?.low ?? '—'}\n行情时间：${quoteTime(q)}（北京时间）\n来源：东方财富。不同地区交易时段不同，行情可能延迟，以所示时间为准。`);
    if (this.paused) tip.appendText('\n自动刷新已暂停。');
    if (this.cached && q) tip.appendText('\n当前展示上次保存的缓存行情。');
    if (error) tip.appendText(`\n${error}`);
    tip.appendText('\n点击在浏览器打开该指数详情。'); item.tooltip = tip;
    item.accessibilityInformation = { label: `${entry.name} ${entry.code}，指数点位 ${q?.price ?? '未知'}，涨跌幅 ${percentText(q?.percent ?? null)}，行情时间 ${quoteTime(q)}${error ? '，获取失败' : ''}` };
    return item;
  }
  publish(structural = false) {
    if (this.disposed) return;
    const description = !this.enabled ? '已禁用' : this.paused ? '已暂停' : this.tree.visible ? '10秒刷新 · 东方财富' : '展开后10秒刷新';
    if (this.tree.description !== description) this.tree.description = description;
    const message = this.errors.size ? `${this.errors.size} 个指数未更新，保留上次行情；悬停可查看数据时间和原因。` : undefined;
    if (this.tree.message !== message) this.tree.message = message;
    const changed = [];
    for (const entry of this.catalog.values()) {
      const signature = JSON.stringify([entry, this.quotes.get(entry.id), this.errors.get(entry.id), this.cached, this.paused]);
      if (signature !== this.signatures.get(entry.id)) { changed.push(entry.id); this.signatures.set(entry.id, signature); }
    }
    if (structural) this.emitter.fire(undefined); else for (const id of changed) this.emitter.fire(this.element(id));
  }
  refresh(automatic = false) {
    if (this.disposed || !this.enabled || (automatic && (this.paused || !this.tree.visible))) return Promise.resolve();
    if (this.inflight && this.abort?.signal.aborted) return this.inflight.then(() => this.refresh(automatic));
    if (this.inflight) return this.inflight;
    const abort = this.abort = new AbortController(), generation = this.generation;
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      let structural = false;
      try {
        const result = await this.provider.load(abort.signal);
        if (this.disposed || abort.signal.aborted || generation !== this.generation) return;
        this.errors = new Map(result.errors);
        for (const [id, entry] of result.entries) {
          if (JSON.stringify(this.catalog.get(id)) !== JSON.stringify(entry)) structural = true;
          this.catalog.set(id, entry);
        }
        for (const id of this.catalog.keys()) if (!result.entries.has(id)) this.errors.set(id, '行情源本次未返回该指数，已保留上次行情');
        for (const [id, q] of result.quotes) {
          if (isGlobalQuote(q) && q.timestamp * 1000 <= this.now().getTime() + 300000 && q.timestamp >= (this.quotes.get(id)?.timestamp || 0)) this.quotes.set(id, q);
          else this.errors.set(id, '行情字段或时间异常，已保留上次行情');
        }
        this.cached = false;
        await this.context.globalState.update('globalIndexQuotes', [...this.quotes.values()]).catch(() => {});
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) {
          for (const id of this.catalog.keys()) this.errors.set(id, error.message || '全球指数获取失败');
          this.log('全球指数行情请求失败');
        }
      } finally {
        this.inflight = null; this.abort = null;
        if (!this.disposed) this.publish(structural);
      }
    })();
    return this.inflight;
  }
  async search() {
    if (this.disposed || !this.enabled) return;
    const items = this.entries().map(entry => {
      const q = this.quotes.get(entry.id), region = REGIONS.find(item => item.id === entry.region);
      return { label: entry.name, description: `${entry.code} · ${region.name} · ${ALIASES[entry.code] || ''}`, detail: `${q ? q.price.toFixed(2) : '—'}　${percentText(q?.percent ?? null)}　行情 ${quoteTime(q)}（北京）`, id: entry.id };
    });
    const selected = await vscode.window.showQuickPick(items, { title: '查询全球指数', placeHolder: '输入名称、代码或地区，例如 日经 / KOSPI / 纳指 / NDX / 美国', matchOnDescription: true });
    if (selected && !this.disposed && this.enabled) await this.tree.reveal(this.element(selected.id), { select: true, focus: true, expand: true });
  }
  async open(element) {
    const id = typeof element === 'string' ? element : element?.id;
    if (!this.catalog.has(id) || this.disposed) return;
    return vscode.env.openExternal(vscode.Uri.parse(globalIndexUrl(id)));
  }
  async togglePause() {
    this.paused = !this.paused; if (this.paused) this.abort?.abort();
    await this.context.globalState.update('globalIndicesPaused', this.paused);
    this.publish();
    if (!this.paused && this.tree.visible) return this.refresh(true);
  }
  dispose() {
    this.disposed = true; clearInterval(this.timer); this.abort?.abort();
    for (const listener of this.listeners) listener.dispose();
    this.tree.dispose(); this.emitter.dispose();
  }
}
module.exports = { GlobalIndicesController, quoteTime };
