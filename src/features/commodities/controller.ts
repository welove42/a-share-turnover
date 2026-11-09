import * as vscode from 'vscode';
import * as privateUI from '../../core/ui/privacy';
import { POLL_MS } from '../turnover/market';
import { signed, percentText } from '../watchlist/quotes';
import { StockSettings } from '../watchlist/settings';
import { trendIcon } from '../watchlist/trend-icon';
import {
  COMMODITIES,
  DEFAULT_COMMODITY_CODES,
  DEFAULT_FUTURES_CODES,
  isFuturesCode,
  entryFor,
  normalizeCommodityCodes,
  isCommodityQuote,
  CommodityProvider,
  commodityUrl
} from './data';

class CommoditiesController {
  readonly section: 'commodities' | 'futures';
  readonly title: string;
  readonly defaults: string[];
  readonly cacheKey: string;
  readonly catalog: typeof COMMODITIES;
  declare context: any;
  declare provider: CommodityProvider;
  declare now: () => Date;
  declare log: (message: string) => void;
  declare settings: StockSettings;
  declare quotes: Map<any, any>;
  declare errors: Map<any, any>;
  declare elements: Map<any, any>;
  declare signatures: Map<any, any>;
  declare disposed: boolean;
  declare inflight: any;
  declare abort: AbortController | null;
  declare generation: number;
  declare lastAttempt: number;
  declare cached: boolean;
  declare paused: boolean;
  declare emitter: vscode.EventEmitter<any>;
  declare onDidChangeTreeData: vscode.Event<any>;
  declare tree: vscode.TreeView<any>;
  declare listeners: vscode.Disposable[];
  declare enabled: boolean;
  declare configError: any;
  declare codes: string[];
  declare timer: NodeJS.Timeout | undefined;
  declare writingSettings: any;
  declare hidden: any;

  constructor(
    context,
    {
      provider = new CommodityProvider(),
      now = () => new Date(),
      log = (_message: string) => {},
      section = 'commodities' as 'commodities' | 'futures'
    } = {}
  ) {
    this.section = section;
    this.title = section === 'futures' ? '期货' : '全球商品';
    this.defaults = section === 'futures' ? DEFAULT_FUTURES_CODES : DEFAULT_COMMODITY_CODES;
    this.cacheKey = section === 'futures' ? 'futuresQuotes' : 'commodityQuotes';
    this.catalog = COMMODITIES.filter((entry) => isFuturesCode(entry.code) === (section === 'futures'));
    this.context = context;
    this.provider = provider;
    this.now = now;
    this.log = log;
    this.settings = new StockSettings(context, (message) => log(message.replace('自选股设置', this.title + '设置')));
    this.quotes = new Map();
    this.errors = new Map();
    this.elements = new Map();
    this.signatures = new Map();
    this.disposed = false;
    this.inflight = null;
    this.abort = null;
    this.generation = 0;
    this.lastAttempt = -Infinity;
    this.cached = true;
    this.paused = Boolean(context.globalState.get(`${section}Paused`, false));
    const cache = context.globalState.get(this.cacheKey, []);
    if (Array.isArray(cache))
      for (const q of cache) if (isCommodityQuote(q) && this.accepts(q.code)) this.quotes.set(q.code, q);
    this.readConfig();
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView(`welove42.aShareTurnover.${section}`, { treeDataProvider: this });
    this.listeners = [
      this.tree.onDidChangeVisibility((event) => {
        this.publish();
        if (!event.visible) this.abort?.abort();
        else void this.refresh(true);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (this.writingSettings || !event.affectsConfiguration(`aShareTurnover.${section}`)) return;
        this.generation++;
        this.abort?.abort();
        this.readConfig();
        this.publish(true);
        void this.refresh(true);
      })
    ];
  }
  accepts(code: string): boolean {
    return this.catalog.some((entry) => entry.code === code);
  }
  normalizeSelection(input: unknown): string[] {
    const codes = normalizeCommodityCodes(input);
    if (codes.some((code) => !this.accepts(code)))
      throw new Error(`请在“${this.section === 'futures' ? '全球商品' : '期货'}”栏目添加该品种。`);
    return codes;
  }
  readConfig() {
    this.enabled = this.settings.get(`${this.section}.enabled`, true);
    this.configError = '';
    try {
      this.codes = this.normalizeSelection(this.settings.get(`${this.section}.symbols`, this.defaults));
    } catch (error) {
      this.configError = error.message;
      this.codes ||= [...this.defaults];
    }
  }
  start() {
    this.publish(true);
    this.timer = setInterval(() => void this.tick(), 1000);
    void this.refresh(true);
  }
  tick() {
    if (!this.inflight && this.now().getTime() - this.lastAttempt >= POLL_MS) return this.refresh(true);
  }
  getChildren(element) {
    return this.enabled && !this.hidden && !element ? this.codes.map((code) => this.element(code)) : [];
  }
  element(code) {
    if (!this.elements.has(code)) this.elements.set(code, { kind: 'commodity', code });
    return this.elements.get(code);
  }
  getParent() {
    return undefined;
  }
  getTreeItem(element) {
    const entry = entryFor(element.code)!,
      q = this.quotes.get(element.code),
      error = this.errors.get(element.code);
    const domestic = entry.market === 'domesticFutures';
    const item = new vscode.TreeItem(
      `${percentText(q?.percent ?? null).padStart(7)}   ${(q?.priceText || '—').padStart(9)}   [${entry.name}]`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `${this.section}:${entry.code}`;
    item.contextValue = this.section === 'futures' ? 'aShareFuture' : 'aShareCommodity';
    item.description = `${entry.unit} · ${error ? '未更新 · ' : this.cached && q ? '缓存 · ' : ''}${q ? `${q.date.slice(5)} ${q.time}` : '待获取'}`;
    item.iconPath = error ? new vscode.ThemeIcon('warning') : trendIcon(this.context.extensionUri, q?.percent);
    item.command = {
      command: `welove42.aShareTurnover.${this.section}.open`,
      title: '查看商品行情详情',
      arguments: [entry.code]
    };
    const tip = new vscode.MarkdownString();
    tip.isTrusted = false;
    tip.supportHtml = false;
    tip.appendText(
      [
        `${entry.name}（${entry.code}）\n`,
        `报价：${q?.priceText || '—'} ${entry.unit}`,
        `涨跌幅：${percentText(q?.percent ?? null)}　涨跌额：${signed(q?.delta ?? null, 3)}`,
        `今开：${q?.open ?? '—'}　${domestic ? '昨结算' : '昨收'}：${(domestic ? q?.previousSettlement : q?.previousClose) ?? '—'}`,
        `最高：${q?.high ?? '—'}　最低：${q?.low ?? '—'}`,
        ...(domestic
          ? [`结算价：${q?.settlement ?? '—'}　成交量：${q?.volume ?? '—'} 手　持仓量：${q?.openInterest ?? '—'} 手`]
          : []),
        `行情时间：${q ? `${q.date} ${q.time}（北京时间）` : '尚未获取'}`,
        domestic
          ? '来源：新浪财经国内期货主力连续行情；合约随主力切换，涨跌幅按来源昨结算计算。'
          : '来源：新浪财经 CFD 参考行情（差价合约报价，非交易所逐笔成交价）；涨跌幅按来源昨收计算。',
        '公开行情可能延迟或处于休市，请以所示报价时间为准。'
      ].join('\n')
    );
    if (this.paused) tip.appendText('\n自动刷新已暂停。');
    if (this.cached && q) tip.appendText('\n当前使用上次保存的缓存报价。');
    if (error) tip.appendText(`\n${error}`);
    tip.appendText('\n点击在浏览器查看该商品图表；右键或行末垃圾桶可移除。');
    item.tooltip = tip;
    item.accessibilityInformation = {
      label: `${entry.name}，${q?.priceText || '未知'} ${entry.unit}，涨跌幅 ${percentText(q?.percent ?? null)}，${q ? q.date + ' ' + q.time : '待获取'}，${domestic ? '国内期货主力连续行情' : 'CFD参考行情'}`
    };
    return item;
  }
  publish(structural = false) {
    if (this.disposed) return;
    this.tree.title = this.hidden ? '断点' : this.title;
    if (this.hidden) {
      this.tree.description = undefined;
      this.tree.message = undefined;
      if (structural) this.emitter.fire(undefined);
      return;
    }
    const description = !this.enabled
      ? '已禁用'
      : this.paused
        ? '已暂停 · 新浪财经'
        : !this.codes.length
          ? `点击＋添加${this.title}`
          : this.tree.visible
            ? '10秒刷新 · 新浪财经'
            : '展开后10秒刷新 · 新浪财经';
    if (this.tree.description !== description) this.tree.description = description;
    const failures = this.codes.filter((code) => this.errors.has(code)).length;
    const message =
      this.configError ||
      (!this.codes.length
        ? `尚未添加${this.title}，点击右上角＋按名称或代码添加。`
        : failures
          ? `${failures} 个商品未更新，保留上次报价；悬停可查看原因。`
          : undefined);
    if (this.tree.message !== message) this.tree.message = message;
    const changed: string[] = [];
    for (const code of this.codes) {
      const signature = JSON.stringify([this.quotes.get(code), this.errors.get(code), this.cached, this.paused]);
      if (signature !== this.signatures.get(code)) {
        changed.push(code);
        this.signatures.set(code, signature);
      }
    }
    if (structural) this.emitter.fire(undefined);
    else for (const code of changed) this.emitter.fire(this.element(code));
  }
  refresh(automatic = false) {
    if (
      this.disposed ||
      this.hidden ||
      !this.enabled ||
      !this.codes.length ||
      (automatic && (this.paused || !this.tree.visible))
    )
      return Promise.resolve();
    if (this.inflight && this.abort?.signal.aborted) return this.inflight.then(() => this.refresh(automatic));
    if (this.inflight) return this.inflight;
    const abort = (this.abort = new AbortController()),
      generation = this.generation,
      codes = [...this.codes];
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      try {
        const result = await this.provider.load(codes, abort.signal);
        if (this.disposed || abort.signal.aborted || generation !== this.generation) return;
        this.errors = new Map();
        for (const code of codes) {
          const q = result.quotes.get(code),
            error = result.errors.get(code);
          if (
            !error &&
            isCommodityQuote(q) &&
            q.code === code &&
            q.timestamp * 1000 <= this.now().getTime() + 300000 &&
            q.timestamp >= (this.quotes.get(code)?.timestamp || 0)
          )
            this.quotes.set(code, q);
          else this.errors.set(code, error || '行情字段或时间异常，已保留上次报价');
        }
        this.cached = false;
        await this.context.globalState.update(this.cacheKey, [...this.quotes.values()]).catch(() => {});
      } catch (error) {
        if (!this.disposed && !abort.signal.aborted) {
          for (const code of codes) this.errors.set(code, error.message || '商品行情获取失败');
          this.log(this.title + '行情请求失败');
        }
      } finally {
        this.inflight = null;
        this.abort = null;
        if (!this.disposed) this.publish();
      }
    })();
    return this.inflight;
  }
  async saveSelection(codes) {
    if (this.disposed) return;
    const selected = this.normalizeSelection(codes);
    this.writingSettings = (this.writingSettings || 0) + 1;
    try {
      await this.settings.set(`${this.section}.symbols`, selected);
    } finally {
      this.writingSettings--;
    }
    if (this.disposed) return;
    this.generation++;
    this.abort?.abort();
    this.readConfig();
    this.publish(true);
    void this.refresh(true);
  }
  async add(input?: unknown) {
    if (this.disposed || !this.enabled) return;
    // Codes may contain digits (LC0 / LH0); names and abbreviations still go through the picker.
    let codes: string[] | undefined;
    if (Array.isArray(input) || typeof input === 'string') {
      try {
        codes = this.normalizeSelection(input);
      } catch (error) {
        if (Array.isArray(input)) return privateUI.showErrorMessage(error.message);
      }
    }
    if (codes) return this.saveSelection([...this.codes, ...codes]);
    const query = typeof input === 'string' ? input.trim().toLowerCase() : '';
    const items = this.catalog
      .filter((entry) => !query || `${entry.name} ${entry.code} ${entry.aliases}`.toLowerCase().includes(query))
      .map((entry) => ({
        label: entry.name,
        description: `${entry.code} · ${entry.market === 'domesticFutures' ? 'nf' : 'hf'}_${entry.code} · ${entry.aliases}${this.codes.includes(entry.code) ? ' · 已添加' : ''}`,
        detail: `${entry.unit} · 新浪财经${entry.market === 'domesticFutures' ? '国内期货主连 · 按昨结算计算涨跌' : ' CFD参考行情'}`,
        code: entry.code
      }));
    if (!items.length) return privateUI.showErrorMessage('未找到该商品或期货，请点击＋搜索支持的名称或代码。');
    const selected = await privateUI.showQuickPick(items, {
      title: `添加${this.title}`,
      placeHolder:
        this.section === 'futures'
          ? '搜索碳酸锂、生猪、纳指100或代码；可多选添加'
          : '输入商品名称、拼音简称或代码；可多选添加',
      matchOnDescription: true,
      canPickMany: true
    });
    if (selected?.length && !this.disposed && this.enabled)
      await this.saveSelection([...this.codes, ...selected.map((item) => item.code)]);
  }
  async remove(element) {
    if (this.disposed || !this.enabled) return;
    let code = typeof element === 'string' ? element : element?.code;
    if (!code)
      code = (
        await privateUI.showQuickPick(
          this.codes.map((code) => ({ label: entryFor(code)!.name, description: code, code })),
          { title: `移除${this.title}` }
        )
      )?.code;
    if (!code || this.disposed || !this.enabled) return;
    try {
      code = this.normalizeSelection([code])[0];
    } catch (error) {
      return privateUI.showErrorMessage(error.message);
    }
    await this.saveSelection(this.codes.filter((current) => current !== code));
  }
  open(element) {
    const code = typeof element === 'string' ? element : element?.code;
    if (this.disposed || !this.accepts(code)) return;
    return vscode.env.openExternal(vscode.Uri.parse(commodityUrl(code)));
  }
  async togglePause() {
    this.paused = !this.paused;
    if (this.paused) this.abort?.abort();
    await this.context.globalState.update(`${this.section}Paused`, this.paused);
    this.publish();
    if (!this.paused) return this.refresh(true);
  }
  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) {
      this.generation++;
      this.abort?.abort();
    }
    this.publish(true);
    if (!hidden && this.enabled && !this.paused)
      void (this.inflight || Promise.resolve()).then(() => {
        if (!this.disposed && !this.hidden && !this.paused) return this.refresh(true);
      });
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.abort?.abort();
    for (const listener of this.listeners) listener.dispose();
    this.tree.dispose();
    this.emitter.dispose();
  }
}
export { CommoditiesController };
