'use strict';
const vscode = require('vscode');
const { POLL_MS } = require('./market');
const { signed, percentText } = require('./quotes');
const { StockSettings } = require('./stock-settings');
const { trendIcon } = require('./trend-icon');
const { COMMODITIES, DEFAULT_COMMODITY_CODES, entryFor, normalizeCommodityCodes, isCommodityQuote, CommodityProvider, commodityUrl } = require('./commodity-data');

class CommoditiesController {
  constructor(context, { provider = new CommodityProvider(), now = () => new Date(), log = () => {} } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.log = log;
    this.settings = new StockSettings(context, message => log(message.replace('自选股设置', '全球商品设置')));
    this.quotes = new Map(); this.errors = new Map(); this.elements = new Map(); this.signatures = new Map();
    this.disposed = false; this.inflight = null; this.abort = null; this.generation = 0; this.lastAttempt = -Infinity; this.cached = true;
    this.paused = Boolean(context.globalState.get('commoditiesPaused', false));
    const cache = context.globalState.get('commodityQuotes', []);
    if (Array.isArray(cache)) for (const q of cache) if (isCommodityQuote(q)) this.quotes.set(q.code, q);
    this.readConfig(); this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView('welove42.aShareTurnover.commodities', { treeDataProvider: this });
    this.listeners = [this.tree.onDidChangeVisibility(event => {
      this.publish();
      if (!event.visible) this.abort?.abort(); else void this.refresh(true);
    }), vscode.workspace.onDidChangeConfiguration(event => {
      if (this.writingSettings || !event.affectsConfiguration('aShareTurnover.commodities')) return;
      this.generation++; this.abort?.abort(); this.readConfig(); this.publish(true);
      void this.refresh(true);
    })];
  }
  readConfig() {
    this.enabled = vscode.workspace.getConfiguration('aShareTurnover').get('commodities.enabled', true);
    this.configError = '';
    try { this.codes = normalizeCommodityCodes(this.settings.get('commodities.symbols', DEFAULT_COMMODITY_CODES)); }
    catch (error) { this.configError = error.message; this.codes ||= [...DEFAULT_COMMODITY_CODES]; }
  }
  start() { this.publish(true); this.timer = setInterval(() => void this.tick(), 1000); void this.refresh(true); }
  tick() {
    if (!this.inflight && this.now().getTime() - this.lastAttempt >= POLL_MS) return this.refresh(true);
  }
  getChildren(element) { return this.enabled && !element ? this.codes.map(code => this.element(code)) : []; }
  element(code) { if (!this.elements.has(code)) this.elements.set(code, { kind: 'commodity', code }); return this.elements.get(code); }
  getParent() { return undefined; }
  getTreeItem(element) {
    const entry = entryFor(element.code), q = this.quotes.get(element.code), error = this.errors.get(element.code);
    const item = new vscode.TreeItem(`${percentText(q?.percent ?? null).padStart(7)}   ${(q?.priceText || '—').padStart(9)}   [${entry.name}]`, vscode.TreeItemCollapsibleState.None);
    item.id = `commodity:${entry.code}`; item.contextValue = 'aShareCommodity';
    item.description = `${entry.unit} · ${error ? '未更新 · ' : this.cached && q ? '缓存 · ' : ''}${q ? `${q.date.slice(5)} ${q.time}` : '待获取'}`;
    item.iconPath = error ? new vscode.ThemeIcon('warning') : trendIcon(this.context.extensionUri, q?.percent);
    item.command = { command: 'welove42.aShareTurnover.commodities.open', title: '查看商品行情详情', arguments: [entry.code] };
    const tip = new vscode.MarkdownString(); tip.isTrusted = false; tip.supportHtml = false;
    tip.appendText(`${entry.name}（${entry.code}）\n\n报价：${q?.priceText || '—'} ${entry.unit}\n涨跌幅：${percentText(q?.percent ?? null)}　涨跌额：${signed(q?.delta ?? null, 3)}\n今开：${q?.open ?? '—'}　昨收：${q?.previousClose ?? '—'}\n最高：${q?.high ?? '—'}　最低：${q?.low ?? '—'}\n行情时间：${q ? `${q.date} ${q.time}（北京时间）` : '尚未获取'}\n来源：新浪财经 CFD 参考行情（差价合约报价，非交易所逐笔成交价）。\n涨跌幅按来源昨收计算；公开行情可能延迟或处于休市，请以所示报价时间为准。`);
    if (this.paused) tip.appendText('\n自动刷新已暂停。');
    if (this.cached && q) tip.appendText('\n当前使用上次保存的缓存报价。');
    if (error) tip.appendText(`\n${error}`);
    tip.appendText('\n点击在浏览器查看该商品图表；右键或行末垃圾桶可移除。'); item.tooltip = tip;
    item.accessibilityInformation = { label: `${entry.name}，${q?.priceText || '未知'} ${entry.unit}，涨跌幅 ${percentText(q?.percent ?? null)}，${q ? q.date + ' ' + q.time : '待获取'}，CFD参考行情` };
    return item;
  }
  publish(structural = false) {
    if (this.disposed) return;
    const description = !this.enabled ? '已禁用' : this.paused ? '已暂停 · CFD' : !this.codes.length ? '点击＋添加商品' : this.tree.visible ? '10秒刷新 · 新浪CFD' : '展开后10秒刷新 · CFD';
    if (this.tree.description !== description) this.tree.description = description;
    const failures = this.codes.filter(code => this.errors.has(code)).length;
    const message = this.configError || (!this.codes.length ? '尚未添加商品，点击右上角＋按名称或代码添加。' : failures ? `${failures} 个商品未更新，保留上次报价；悬停可查看原因。` : undefined);
    if (this.tree.message !== message) this.tree.message = message;
    const changed = [];
    for (const code of this.codes) {
      const signature = JSON.stringify([this.quotes.get(code), this.errors.get(code), this.cached, this.paused]);
      if (signature !== this.signatures.get(code)) { changed.push(code); this.signatures.set(code, signature); }
    }
    if (structural) this.emitter.fire(undefined); else for (const code of changed) this.emitter.fire(this.element(code));
  }
  refresh(automatic = false) {
    if (this.disposed || !this.enabled || !this.codes.length || (automatic && (this.paused || !this.tree.visible))) return Promise.resolve();
    if (this.inflight && this.abort?.signal.aborted) return this.inflight.then(() => this.refresh(automatic));
    if (this.inflight) return this.inflight;
    const abort = this.abort = new AbortController(), generation = this.generation, codes = [...this.codes];
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      try {
        const result = await this.provider.load(codes, abort.signal);
        if (this.disposed || abort.signal.aborted || generation !== this.generation) return;
        this.errors = new Map();
        for (const code of codes) {
          const q = result.quotes.get(code), error = result.errors.get(code);
          if (!error && isCommodityQuote(q) && q.code === code && q.timestamp * 1000 <= this.now().getTime() + 300000 && q.timestamp >= (this.quotes.get(code)?.timestamp || 0)) this.quotes.set(code, q);
          else this.errors.set(code, error || '行情字段或时间异常，已保留上次报价');
        }
        this.cached = false;
        await this.context.globalState.update('commodityQuotes', [...this.quotes.values()]).catch(() => {});
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) {
          for (const code of codes) this.errors.set(code, error.message || '商品行情获取失败');
          this.log('全球商品行情请求失败');
        }
      } finally { this.inflight = null; this.abort = null; if (!this.disposed) this.publish(); }
    })();
    return this.inflight;
  }
  async saveSelection(codes) {
    if (this.disposed) return;
    const selected = normalizeCommodityCodes(codes);
    this.writingSettings = (this.writingSettings || 0) + 1;
    try { await this.settings.set('commodities.symbols', selected); } finally { this.writingSettings--; }
    if (this.disposed) return;
    this.generation++; this.abort?.abort(); this.readConfig(); this.publish(true); void this.refresh(true);
  }
  async add(input) {
    if (this.disposed || !this.enabled) return;
    if (Array.isArray(input) || typeof input === 'string' && /^[a-zA-Z_,，;；\s]+$/.test(input)) {
      try { return await this.saveSelection([...this.codes, ...normalizeCommodityCodes(input)]); }
      catch (error) { return vscode.window.showErrorMessage(error.message); }
    }
    const query = typeof input === 'string' ? input.trim().toLowerCase() : '';
    const items = COMMODITIES.filter(entry => !query || `${entry.name} ${entry.code} ${entry.aliases}`.toLowerCase().includes(query)).map(entry => ({
      label: entry.name, description: `${entry.code} · ${entry.aliases}${this.codes.includes(entry.code) ? ' · 已添加' : ''}`,
      detail: `${entry.unit} · 新浪财经 CFD参考行情`, code: entry.code
    }));
    const selected = await vscode.window.showQuickPick(items, { title: '添加全球商品', placeHolder: '输入名称、拼音简称或代码；可勾选多个商品后回车添加', matchOnDescription: true, canPickMany: true });
    if (selected?.length && !this.disposed && this.enabled) await this.saveSelection([...this.codes, ...selected.map(item => item.code)]);
  }
  async remove(element) {
    if (this.disposed || !this.enabled) return;
    let code = typeof element === 'string' ? element : element?.code;
    if (!code) code = (await vscode.window.showQuickPick(this.codes.map(code => ({ label: entryFor(code).name, description: code, code })), { title: '移除全球商品' }))?.code;
    if (!code || this.disposed || !this.enabled) return;
    try { code = normalizeCommodityCodes([code])[0]; } catch (error) { return vscode.window.showErrorMessage(error.message); }
    await this.saveSelection(this.codes.filter(current => current !== code));
  }
  open(element) {
    const code = typeof element === 'string' ? element : element?.code;
    if (this.disposed || !entryFor(code)) return;
    return vscode.env.openExternal(vscode.Uri.parse(commodityUrl(code)));
  }
  async togglePause() {
    this.paused = !this.paused; if (this.paused) this.abort?.abort();
    await this.context.globalState.update('commoditiesPaused', this.paused); this.publish();
    if (!this.paused) return this.refresh(true);
  }
  dispose() {
    this.disposed = true; clearInterval(this.timer); this.abort?.abort();
    for (const listener of this.listeners) listener.dispose();
    this.tree.dispose(); this.emitter.dispose();
  }
}
module.exports = { CommoditiesController };
