'use strict';
const vscode = require('vscode');
const privateUI = require('./privacy-ui');
const { POLL_MS, shanghaiClock } = require('./market');
const { signed, percentText } = require('./quotes');
const { REGIONS, ALIASES, DEFAULT_INDEX_IDS, BUILTIN_INDICES, normalizeIndexIds, indexEntry, isGlobalQuote, GlobalIndexProvider, globalIndexUrl } = require('./global-index-data');
const { StockSettings } = require('./stock-settings');
const { trendIcon } = require('./trend-icon');

function quoteTime(q) {
  if (!q) return '尚未获取';
  const clock = shanghaiClock(new Date(q.timestamp * 1000));
  return `${clock.date} ${clock.time}`;
}
class GlobalIndicesController {
  constructor(context, { provider = new GlobalIndexProvider(), now = () => new Date(), log = () => {} } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.log = log;
    this.settings = new StockSettings(context, message => log(message.replace('自选股设置', '全球指数设置')));
    this.catalog = new Map(BUILTIN_INDICES.map(entry => [entry.id, entry]));
    const savedCatalog = context.globalState.get('globalIndexCatalog', []);
    if (Array.isArray(savedCatalog)) for (const entry of savedCatalog) { try { const valid = indexEntry(entry.code, entry.name); this.catalog.set(valid.id, valid); } catch {} }
    this.quotes = new Map(); this.errors = new Map(); this.elements = new Map(); this.signatures = new Map();
    this.disposed = false; this.inflight = null; this.abort = null; this.generation = 0; this.lastAttempt = -Infinity; this.cached = true;
    this.failureCount = 0; this.pollDelay = POLL_MS; this.sourceTimes = new Map(); this.catalogRetryAt = 0;
    this.paused = Boolean(context.globalState.get('globalIndicesPaused', false));
    const cache = context.globalState.get('globalIndexQuotes', []);
    if (Array.isArray(cache)) for (const q of cache) if (isGlobalQuote(q)) { this.quotes.set(q.id, q); this.catalog.set(q.id, { id: q.id, code: q.code, name: q.name, region: q.region }); }
    this.enabled = this.readEnabled();
    this.readSelection();
    this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView('welove42.aShareTurnover.globalIndices', { treeDataProvider: this });
    this.listeners = [this.tree.onDidChangeVisibility(event => {
      this.publish();
      if (!event.visible) this.abort?.abort();
      else if (this.enabled && !this.paused) void this.refresh(true);
    }), vscode.workspace.onDidChangeConfiguration(event => {
      if (this.writingSelection || !event.affectsConfiguration('aShareTurnover.globalIndices')) return;
      const enabled = this.readEnabled();
      this.generation++; this.abort?.abort();
      this.enabled = enabled; this.readSelection(); this.publish(true);
      if (this.enabled && !this.paused && this.tree.visible) void this.refresh(true);
    })];
  }
  readEnabled() { return vscode.workspace.getConfiguration('aShareTurnover').get('globalIndices.enabled', true); }
  readSelection() {
    this.selectionError = '';
    try { this.selectedIds = normalizeIndexIds(this.settings.get('globalIndices.symbols', DEFAULT_INDEX_IDS)); }
    catch (error) { this.selectionError = error.message; this.selectedIds ||= [...DEFAULT_INDEX_IDS]; }
    for (const id of this.selectedIds) if (!this.catalog.has(id)) this.catalog.set(id, indexEntry(id.slice(4), id.slice(4)));
  }
  start() {
    this.publish(true); this.timer = setInterval(() => void this.tick(), 1000);
    if (this.enabled && !this.paused && this.selectedIds.length) void this.refresh(true);
  }
  tick() {
    if (!this.disposed && this.enabled && this.selectedIds.length && !this.paused && this.tree.visible && !this.inflight && this.now().getTime() - this.lastAttempt >= this.pollDelay) return this.refresh(true);
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
    return this.enabled && !this.hidden && !element ? this.selectedIds.map(id => this.element(id)) : [];
  }
  element(id) {
    if (!this.elements.has(id)) this.elements.set(id, { kind: 'globalIndex', id });
    return this.elements.get(id);
  }
  getParent() { return undefined; }
  getTreeItem(element) {
    const entry = this.catalog.get(element.id), q = this.quotes.get(element.id), error = this.errors.get(element.id);
    const item = new vscode.TreeItem(`${percentText(q?.percent ?? null).padStart(7)}   ${(q ? q.price.toFixed(2) : '—').padStart(9)}   [${entry.name}]`, vscode.TreeItemCollapsibleState.None);
    item.id = `global-index:${entry.id}`; item.contextValue = 'aShareGlobalIndex';
    item.description = `${error ? '获取失败 · ' : this.cached && q ? '缓存 · ' : q?.source === 'sina' ? '备用 · ' : ''}${q ? quoteTime(q).slice(5, 16) : '待获取'}`;
    item.iconPath = error ? new vscode.ThemeIcon('warning') : trendIcon(this.context.extensionUri, q?.percent);
    item.command = { command: 'welove42.aShareTurnover.globalIndices.open', title: '在浏览器查看指数详情', arguments: [entry.id] };
    const tip = new vscode.MarkdownString(); tip.isTrusted = false; tip.supportHtml = false;
    tip.appendText(`${entry.name}（${entry.code}）\n\n地区：${REGIONS.find(region => region.id === entry.region).name}\n指数点位：${q ? q.price.toFixed(2) : '—'}　涨跌幅：${percentText(q?.percent ?? null)}\n涨跌点数：${signed(q?.delta ?? null, 2)}\n今开：${q?.open ?? '—'}　昨收：${q?.previousClose ?? '—'}\n最高：${q?.high ?? '—'}　最低：${q?.low ?? '—'}\n${q?.timestampKind === 'updated' ? '来源更新时间' : '行情时间'}：${quoteTime(q)}（北京时间）\n来源：${q?.source === 'sina' ? '新浪财经（备用源）' : '东方财富'}。不同地区交易时段不同，行情可能延迟，以所示时间为准。`);
    if (q?.timestampKind === 'updated') tip.appendText('\n备用源时间表示该源的报价更新时间，不代表交易所逐笔成交时间。');
    if (this.paused) tip.appendText('\n自动刷新已暂停。');
    if (this.cached && q) tip.appendText('\n当前展示上次保存的缓存行情。');
    if (error) tip.appendText(`\n${error}`);
    tip.appendText('\n点击在浏览器打开该指数详情。'); item.tooltip = tip;
    item.accessibilityInformation = { label: `${entry.name} ${entry.code}，指数点位 ${q?.price ?? '未知'}，涨跌幅 ${percentText(q?.percent ?? null)}，行情时间 ${quoteTime(q)}${error ? '，获取失败' : ''}` };
    return item;
  }
  publish(structural = false) {
    if (this.disposed) return;
    this.tree.title = this.hidden ? '监视' : '全球指数';
    if (this.hidden) { this.tree.description = undefined; this.tree.message = undefined; if (structural) this.emitter.fire(undefined); return; }
    const description = !this.enabled ? '已禁用' : this.paused ? '已暂停' : !this.selectedIds.length ? '点击＋添加指数' : this.tree.visible ? this.pollDelay > POLL_MS ? `每${this.pollDelay / 1000}秒重试 · 多源行情` : '10秒刷新 · 多源行情' : '展开后10秒刷新';
    if (this.tree.description !== description) this.tree.description = description;
    const failures = this.selectedIds.filter(id => this.errors.has(id)).length;
    const message = this.selectionError || (!this.selectedIds.length ? '尚未添加指数，点击右上角＋搜索添加。' : failures ? `${failures} 个指数未更新，保留上次行情；悬停可查看数据时间和原因。` : undefined);
    if (this.tree.message !== message) this.tree.message = message;
    const changed = [];
    for (const id of this.selectedIds) {
      const entry = this.catalog.get(id);
      const signature = JSON.stringify([entry, this.quotes.get(entry.id), this.errors.get(entry.id), this.cached, this.paused]);
      if (signature !== this.signatures.get(entry.id)) { changed.push(entry.id); this.signatures.set(entry.id, signature); }
    }
    if (structural) this.emitter.fire(undefined); else for (const id of changed) this.emitter.fire(this.element(id));
  }
  refresh(automatic = false) {
    if (this.disposed || this.hidden || !this.enabled || !this.selectedIds.length || (automatic && (this.paused || !this.tree.visible))) return Promise.resolve();
    if (this.inflight && this.abort?.signal.aborted) return this.inflight.then(() => this.refresh(automatic));
    if (this.inflight) return this.inflight;
    const abort = this.abort = new AbortController(), generation = this.generation, selected = [...this.selectedIds];
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      let structural = false;
      try {
        const result = await this.provider.load(selected, abort.signal);
        if (this.disposed || abort.signal.aborted || generation !== this.generation) return;
        this.errors = new Map();
        for (const [id, entry] of result.entries) {
          if (this.selectedIds.includes(id) && JSON.stringify(this.catalog.get(id)) !== JSON.stringify(entry)) structural = true;
          this.catalog.set(id, entry);
        }
        for (const id of selected) {
          const q = result.quotes.get(id), previous = this.quotes.get(id), source = q?.source || 'eastmoney';
          const sameSource = previous && (previous.source || 'eastmoney') === source;
          const floor = Math.max(this.sourceTimes.get(`${id}:${source}`) || 0, sameSource ? previous.timestamp : 0);
          // Cross-source clocks differ (trade time vs update time). Compare each
          // source against its own last timestamp; reject earlier calendar days.
          const oldDay = previous ? quoteTime(previous).slice(0, 10) : '', newDay = isGlobalQuote(q) ? quoteTime(q).slice(0, 10) : '';
          if (!result.errors.has(id) && isGlobalQuote(q) && q.id === id && q.timestamp * 1000 <= this.now().getTime() + 300000 && q.timestamp >= floor && newDay >= oldDay) {
            this.quotes.set(id, q); this.sourceTimes.set(`${id}:${source}`, q.timestamp);
          } else this.errors.set(id, result.errors.get(id) || '行情字段或时间异常，已保留上次行情');
        }
        this.cached = false;
        this.failureCount = this.errors.size === selected.length ? this.failureCount + 1 : 0;
        this.pollDelay = Math.min(60000, POLL_MS * 2 ** Math.min(this.failureCount, 3));
        if (this.errors.size) this.log(`全球指数：${[...this.errors].map(([id, error]) => `${id} ${error}`).join('；')}`);
        await this.context.globalState.update('globalIndexQuotes', [...this.quotes.values()]).catch(() => {});
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) {
          for (const id of selected) this.errors.set(id, error.message || '全球指数获取失败');
          this.failureCount++; this.pollDelay = Math.min(60000, POLL_MS * 2 ** Math.min(this.failureCount, 3));
          this.log(`全球指数行情请求失败：${error.message}`);
        }
      } finally {
        this.inflight = null; this.abort = null;
        if (!this.disposed) this.publish(structural);
      }
    })();
    return this.inflight;
  }
  async ensureCatalog() {
    if (this.hidden || this.catalogLoaded || this.now().getTime() < this.catalogRetryAt || !this.provider.loadCatalog) return;
    if (this.catalogInflight) return this.catalogInflight;
    const abort = this.catalogAbort = new AbortController();
    this.catalogInflight = (async () => {
      try {
        const result = await this.provider.loadCatalog(abort.signal);
        if (this.disposed || abort.signal.aborted) return;
        for (const entry of result.entries.values()) { const valid = indexEntry(entry.code, entry.name); this.catalog.set(valid.id, valid); }
        this.catalogLoaded = true;
        await this.context.globalState.update('globalIndexCatalog', [...this.catalog.values()]).catch(() => {});
      } catch (error) {
        if (!abort.signal.aborted && !this.disposed) { this.catalogRetryAt = this.now().getTime() + 5 * 60000; this.log(`全球指数目录暂不可用，使用本地候选：${error.message}`); }
      } finally { this.catalogInflight = null; this.catalogAbort = null; }
    })();
    return this.catalogInflight;
  }
  async saveSelection(ids) {
    if (this.disposed) return;
    const selected = normalizeIndexIds(ids);
    this.writingSelection = (this.writingSelection || 0) + 1;
    try { await this.settings.set('globalIndices.symbols', selected); }
    finally { this.writingSelection--; }
    if (this.disposed) return;
    this.generation++; this.abort?.abort(); this.readSelection(); this.publish(true);
    if (!this.paused && this.tree.visible && this.selectedIds.some(id => !this.quotes.has(id))) void this.refresh(true);
  }
  search() { return this.add(); }
  async add(input) {
    if (this.disposed || !this.enabled) return;
    if (typeof input === 'string' || Array.isArray(input)) {
      let ids;
      try { ids = normalizeIndexIds(input); }
      catch (error) { return privateUI.showErrorMessage(error.message); }
      if (ids.some(id => !this.catalog.has(id))) await this.ensureCatalog();
      if (this.disposed || !this.enabled) return;
      const unknown = ids.filter(id => !this.catalog.has(id));
      if (unknown.length) return privateUI.showErrorMessage(`未找到指数 ${unknown.join('、')}，可使用＋按名称或代码搜索`);
      return this.saveSelection([...this.selectedIds, ...ids]);
    }
    // Title actions pass a focused row/context object: always open the add picker.
    if (!this.catalogLoaded) await this.ensureCatalog();
    if (this.disposed || !this.enabled) return;
    const items = this.entries().map(entry => {
      const q = this.quotes.get(entry.id), region = REGIONS.find(item => item.id === entry.region);
      return { label: entry.name, description: `${entry.code} · ${region.name} · ${ALIASES[entry.code] || ''}${this.selectedIds.includes(entry.id) ? ' · 已添加' : ''}`, detail: `${q ? q.price.toFixed(2) : '—'}　${percentText(q?.percent ?? null)}　行情 ${quoteTime(q)}（北京）`, id: entry.id };
    });
    const selected = await privateUI.showQuickPick(items, { title: '添加全球指数', placeHolder: '输入名称、代码或地区；可勾选多个指数后回车添加', matchOnDescription: true, canPickMany: true });
    if (selected?.length && !this.disposed && this.enabled) {
      try { await this.saveSelection([...this.selectedIds, ...selected.map(item => item.id)]); }
      catch (error) { return privateUI.showErrorMessage(error.message); }
    }
  }
  async remove(element) {
    if (this.disposed || !this.enabled) return;
    let id = typeof element === 'string' ? element : element?.id;
    if (!id) {
      const chosen = await privateUI.showQuickPick(this.selectedIds.map(id => ({ label: this.catalog.get(id).name, description: id, id })), { title: '删除全球指数' });
      id = chosen?.id;
    }
    if (!id || this.disposed || !this.enabled) return;
    try { id = normalizeIndexIds([id])[0]; }
    catch (error) { return privateUI.showErrorMessage(error.message); }
    await this.saveSelection(this.selectedIds.filter(current => current !== id));
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
  setHidden(hidden) {
    this.hidden = hidden; if (hidden) { this.generation++; this.abort?.abort(); this.catalogAbort?.abort(); }
    this.publish(true);
    if (!hidden && this.enabled && !this.paused) void (this.inflight || Promise.resolve()).then(() => { if (!this.disposed && !this.hidden && !this.paused) return this.refresh(true); });
  }
  dispose() {
    this.disposed = true; clearInterval(this.timer); this.abort?.abort(); this.catalogAbort?.abort();
    for (const listener of this.listeners) listener.dispose();
    this.tree.dispose(); this.emitter.dispose();
  }
}
module.exports = { GlobalIndicesController, quoteTime };
