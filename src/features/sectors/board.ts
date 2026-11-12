import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { stockSession } from '../turnover/market';
import { CATEGORIES, DIRECTIONS } from './data';
import { SectorBoardProvider, type BoardSnapshot, type BoardQuery } from './board-data';
import { boardHtml } from './board-view';
import { withSectorDeadline } from './request';

/** 只获取当前列表页或云图所需行情，按查询条件分开缓存。 */
export class SectorBoard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private token = '';
  private ready = false;
  private abort?: AbortController;
  private inflight?: Promise<void>;
  private inflightKey = '';
  private cache = new Map<string, BoardSnapshot>();
  private failed = new Map<string, { until: number; message: string }>();
  private requestTimeoutMs = 15000;
  private listeners: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private generation = 0;
  private sent = '';
  private lastCategory = '';
  private lastDirection = '';
  private query: BoardQuery = { view: 'table', page: 1, sort: 'percent', direction: 'gainers', search: '', mapSort: 'amount' };
  constructor(private owner: any, private provider = new SectorBoardProvider()) {
    this.provider.attach?.(owner.context.globalState);
  }
  open() {
    if (this.disposed || this.owner.hidden || !this.owner.enabled) return;
    if (this.panel) { this.panel.reveal(); this.update(); return; }
    const context = this.owner.context;
    const panel = (this.panel = vscode.window.createWebviewPanel('welove42.aShareTurnover.sectorBoard', '板块行情', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews')]
    }));
    this.ready = false;
    this.sent = '';
    this.query = { view: 'table', page: 1, sort: 'percent', direction: this.owner.direction, search: '', mapSort: 'amount' };
    this.lastCategory = this.owner.category;
    this.lastDirection = this.owner.direction;
    this.token = randomBytes(24).toString('hex');
    this.listeners = [
      panel.webview.onDidReceiveMessage((m) => void this.receive(m)),
      panel.onDidChangeViewState(() => { if (panel.visible) this.update(); else this.cancel(); }),
      panel.onDidDispose(() => { this.cancel(); clearInterval(this.timer); this.panel = undefined; this.ready = false; this.listeners.forEach((l) => l.dispose()); this.listeners = []; })
    ];
    panel.webview.html = boardHtml(panel.webview, context, this.token);
    this.timer = setInterval(() => { if (this.panel?.visible && stockSession(this.owner.now(), this.owner.closedDates).polling) this.update(); }, 10000);
  }
  private send(message: any) {
    if (this.panel && this.ready && this.panel.visible) void Promise.resolve(this.panel.webview.postMessage({ ...message, token: this.token })).catch(() => {});
  }
  private sendState(key: string, data: BoardSnapshot | null, stale: boolean) {
    const signature = `${key}:${this.owner.direction}:${JSON.stringify(this.query)}:${data?.source || ''}:${data?.fetchedAt || 0}:${stale}`;
    if (this.sent === signature) return;
    this.sent = signature;
    this.send({ type: 'state', category: this.owner.category, direction: this.owner.direction, query: { ...this.query }, data, stale });
  }
  async receive(m: any) {
    if (!this.panel || m?.token !== this.token || this.owner.hidden) return;
    if (m.action === 'ready') { this.ready = true; this.update(); return; }
    if (m.action === 'refresh') { this.update(true); return; }
    if (m.action === 'query') {
      const v = m.value;
      if (!v || !['table', 'heatmap'].includes(v.view) || !['percent', 'amount', 'volume'].includes(v.sort) || (v.mapSort !== undefined && !['amount', 'gainers', 'losers'].includes(v.mapSort)) || !Number.isInteger(v.page) || v.page < 1 || v.page > 100 || typeof v.search !== 'string' || v.search.length > 40) return;
      this.query = { view: v.view, page: v.page, sort: v.sort, search: v.search.trim(), direction: this.owner.direction, mapSort: v.mapSort || 'amount' };
      // 页面主动请求时必须回送状态，即便命中同一份缓存也要结束加载态。
      this.sent = '';
      this.update(); return;
    }
    if (m.action === 'category' && Object.hasOwn(CATEGORIES, m.value)) return this.configure('sectors.category', m.value);
    if (m.action === 'direction' && Object.hasOwn(DIRECTIONS, m.value)) return this.configure('sectors.direction', m.value);
  }
  private async configure(key: string, value: string) {
    const config = vscode.workspace.getConfiguration('aShareTurnover');
    const target = config.inspect?.(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    try { await config.update(key, value, target); } catch (e) { this.send({ type: 'error', message: `切换失败：${e.message}` }); }
  }
  update(force = false) {
    if (this.disposed || this.owner.hidden || !this.owner.enabled || !this.panel?.visible || !this.ready) return;
    if (this.lastCategory !== this.owner.category || this.lastDirection !== this.owner.direction) {
      this.query.page = 1;
      if (this.lastDirection !== this.owner.direction) this.query.sort = 'percent';
      this.query.direction = this.owner.direction;
      this.lastCategory = this.owner.category;
      this.lastDirection = this.owner.direction;
    }
    const category = this.owner.category, query = { ...this.query }, fetchQuery: BoardQuery = query.view === 'heatmap' ? { view: 'heatmap', page: 1, sort: 'amount', direction: 'gainers', search: '', mapSort: query.mapSort || 'amount' } : query, key = JSON.stringify([category, fetchQuery.view, fetchQuery.page, fetchQuery.sort, fetchQuery.direction, fetchQuery.search, fetchQuery.view === 'heatmap' ? fetchQuery.mapSort : '']), now = this.owner.now().getTime(), cached = this.cache.get(key);
    this.sendState(key, cached || null, !!cached && (Boolean(cached.stale) || now - cached.fetchedAt >= 60000));
    if (this.inflight) {
      if (this.inflightKey !== key) this.cancel();
      else this.send({ type: 'loading', message: '正在获取板块数据，请稍候…' });
      return;
    }
    const failure = this.failed.get(key);
    if (failure && failure.until > now) {
      this.send({
        type: 'error',
        message: `获取失败：${failure.message}。${cached ? '保留上次数据。' : ''}${Math.ceil((failure.until - now) / 1000)} 秒后可重试。`
      });
      return;
    }
    if (cached && now - cached.fetchedAt < 60000) {
      if (force) this.send({ type: 'message', message: cached ? '已使用最近数据，请稍后再刷新。' : '数据源暂不可用，请稍后再试。' });
      return;
    }
    const abort = (this.abort = new AbortController()), generation = ++this.generation;
    this.inflightKey = key;
    this.send({ type: 'loading', message: query.search && query.view === 'table' ? '正在搜索板块…' : query.view === 'heatmap' ? `正在获取${query.mapSort === 'losers' ? '跌幅' : query.mapSort === 'gainers' ? '涨幅' : '成交额'}前50个板块…` : `正在获取第 ${query.page} 页…` });
    this.inflight = (async () => {
      try {
        const data = await withSectorDeadline(
          abort.signal,
          this.requestTimeoutMs,
          (requestSignal) => this.provider.load(category, requestSignal, fetchQuery),
          '板块请求超时，请稍后刷新'
        );
        if (abort.signal.aborted || this.disposed || generation !== this.generation || this.owner.category !== category) return;
        this.cache.set(key, data);
        while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
        this.failed.delete(key);
        this.sendState(key, data, Boolean(data.stale));
      } catch (e) {
        if (!abort.signal.aborted && !this.disposed && generation === this.generation) {
          this.failed.set(key, { until: this.owner.now().getTime() + 60000, message: e.message || '数据源暂不可用' });
          while (this.failed.size > 40) this.failed.delete(this.failed.keys().next().value!);
          this.send({ type: 'error', message: `获取失败：${e.message}。${cached ? '保留上次数据。' : '请稍后刷新。'}` });
        }
      } finally {
        this.inflight = undefined; this.inflightKey = ''; this.abort = undefined;
        if (!this.disposed && this.panel?.visible && abort.signal.aborted) this.update();
      }
    })();
  }
  private cancel() { this.generation++; this.abort?.abort(); }
  setHidden(hidden: boolean) { if (hidden) { this.cancel(); this.panel?.dispose(); } }
  dispose() { this.disposed = true; this.cancel(); clearInterval(this.timer); this.panel?.dispose(); }
}
