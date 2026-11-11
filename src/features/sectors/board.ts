import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { stockSession } from '../turnover/market';
import { CATEGORIES, DIRECTIONS } from './data';
import { SectorBoardProvider, type BoardSnapshot } from './board-data';
import { boardHtml } from './board-view';

/** 仅页面可见时获取完整板块，状态栏原有前十请求保持独立。 */
export class SectorBoard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private token = '';
  private ready = false;
  private abort?: AbortController;
  private inflight?: Promise<void>;
  private inflightCategory?: string;
  private cache = new Map<string, BoardSnapshot>();
  private failed = new Map<string, number>();
  private listeners: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private generation = 0;
  private sent = '';
  constructor(
    private owner: any,
    private provider = new SectorBoardProvider()
  ) {}
  open() {
    if (this.disposed || this.owner.hidden || !this.owner.enabled) return;
    if (this.panel) {
      this.panel.reveal();
      this.update();
      return;
    }
    const context = this.owner.context;
    const panel = (this.panel = vscode.window.createWebviewPanel(
      'welove42.aShareTurnover.sectorBoard',
      '板块行情',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews')
        ]
      }
    ));
    this.ready = false;
    this.sent = '';
    this.token = randomBytes(24).toString('hex');
    this.listeners = [
      panel.webview.onDidReceiveMessage((m) => void this.receive(m)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.update();
        else this.cancel();
      }),
      panel.onDidDispose(() => {
        this.cancel();
        clearInterval(this.timer);
        this.panel = undefined;
        this.ready = false;
        this.listeners.forEach((l) => l.dispose());
        this.listeners = [];
      })
    ];
    panel.webview.html = boardHtml(panel.webview, context, this.token);
    this.timer = setInterval(() => {
      if (this.panel?.visible && stockSession(this.owner.now(), this.owner.closedDates).polling) this.update();
    }, 10000);
  }
  private send(message: any) {
    if (this.panel && this.ready && this.panel.visible)
      void Promise.resolve(this.panel.webview.postMessage({ ...message, token: this.token })).catch(() => {});
  }
  private sendState(category: string, data: BoardSnapshot | null, stale: boolean) {
    const signature = `${category}:${this.owner.direction}:${data?.fetchedAt || 0}:${stale}`;
    if (this.sent === signature) return;
    this.sent = signature;
    this.send({ type: 'state', category, direction: this.owner.direction, data, stale });
  }
  async receive(m: any) {
    if (!this.panel || m?.token !== this.token || this.owner.hidden) return;
    if (m.action === 'ready') {
      this.ready = true;
      this.update();
      return;
    }
    if (m.action === 'refresh') {
      this.update(true);
      return;
    }
    if (m.action === 'category' && Object.hasOwn(CATEGORIES, m.value))
      return this.configure('sectors.category', m.value);
    if (m.action === 'direction' && Object.hasOwn(DIRECTIONS, m.value))
      return this.configure('sectors.direction', m.value);
  }
  private async configure(key: string, value: string) {
    const config = vscode.workspace.getConfiguration('aShareTurnover');
    const target =
      config.inspect?.(key)?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    try {
      await config.update(key, value, target);
    } catch (e) {
      this.send({ type: 'error', message: `切换失败：${e.message}` });
    }
  }
  update(force = false) {
    if (this.disposed || this.owner.hidden || !this.owner.enabled || !this.panel?.visible || !this.ready) return;
    const category = this.owner.category,
      now = this.owner.now().getTime(),
      cached = this.cache.get(category);
    this.sendState(category, cached || null, !!cached && now - cached.fetchedAt >= 60000);
    if (this.inflight) {
      if (this.inflightCategory !== category) this.cancel();
      return;
    }
    if ((cached && now - cached.fetchedAt < 60000) || (this.failed.get(category) || 0) > now) {
      if (force) this.send({ type: 'message', message: cached ? '已使用最近数据，请稍后再刷新。' : '数据源暂不可用，请稍后再试。' });
      return;
    }
    const abort = (this.abort = new AbortController()),
      generation = ++this.generation;
    this.inflightCategory = category;
    this.send({ type: 'loading', message: '正在获取完整板块…' });
    this.inflight = (async () => {
      try {
        const data = await this.provider.load(category, abort.signal, (done, total) => {
          if (!abort.signal.aborted && generation === this.generation && this.owner.category === category)
            this.send({ type: 'loading', message: `正在获取板块 ${done}/${total}…` });
        });
        if (abort.signal.aborted || this.disposed || generation !== this.generation || this.owner.category !== category)
          return;
        this.cache.set(category, data);
        this.failed.delete(category);
        this.sendState(category, data, false);
      } catch (e) {
        if (!abort.signal.aborted && !this.disposed && generation === this.generation) {
          this.failed.set(category, this.owner.now().getTime() + 60000);
          this.send({
            type: 'error',
            message: `获取失败：${e.message}。${cached ? '保留上次数据。' : '请稍后刷新。'}`
          });
        }
      } finally {
        this.inflight = undefined;
        this.inflightCategory = undefined;
        this.abort = undefined;
        if (!this.disposed && this.panel?.visible && (this.owner.category !== category || abort.signal.aborted))
          this.update();
      }
    })();
  }
  private cancel() {
    this.generation++;
    this.abort?.abort();
  }
  setHidden(hidden: boolean) {
    if (hidden) {
      this.cancel();
      this.panel?.dispose();
    }
  }
  dispose() {
    this.disposed = true;
    this.cancel();
    clearInterval(this.timer);
    this.panel?.dispose();
  }
}
