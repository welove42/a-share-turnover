import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { beijing } from './calendar';
import { calendarViewEvent } from './view-model';
import { calendarHtml } from './view';

/** 日历只复用提醒模块已有数据，不额外发起行情请求。 */
export class ReminderBoard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private token = '';
  private ready = false;
  constructor(private owner: any) {}

  open() {
    if (this.owner.hidden || this.owner.disposed) return;
    if (this.panel) { this.panel.reveal(); this.update(); return; }
    const context = this.owner.context;
    const panel = this.panel = vscode.window.createWebviewPanel('welove42.aShareTurnover.eventCalendar', '财经大事日历', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media'), vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews')]
    });
    this.token = randomBytes(24).toString('hex');
    this.ready = false;
    panel.webview.onDidReceiveMessage((message) => void this.receive(message));
    panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.ready = false; } });
    panel.webview.html = calendarHtml(panel.webview, context, this.token);
  }

  update(status?: string) {
    if (!this.panel || !this.ready || this.owner.hidden) return;
    void this.panel.webview.postMessage({ type: 'state', token: this.token,
      today: beijing(this.owner.now().getTime()).slice(0, 10),
      events: this.owner.events().map(calendarViewEvent),
      status: status || (this.owner.onlineErrors.size ? '部分来源暂未更新，已保留可用缓存或快照。' : '使用提醒日历当前数据，来源与更新时间见事件详情。')
    });
  }

  private async receive(message: any) {
    if (!this.panel || this.owner.hidden || message?.token !== this.token) return;
    if (message.action === 'ready') { this.ready = true; this.update(); }
    if (message.action === 'refresh') {
      if (!this.owner.enabled) { this.update('大事提醒已关闭，请在设置中启用后刷新。'); return; }
      this.update('正在检查数据更新…');
      await this.owner.refresh(true);
      this.update('已检查更新；数据源冷却期间继续使用缓存或快照。');
    }
    if (message.action === 'source' && typeof message.id === 'string') {
      const event = this.owner.events().find((entry) => entry.id === message.id);
      if (event && /^https?:\/\//i.test(event.source || '')) await vscode.env.openExternal(vscode.Uri.parse(event.source));
    }
  }
  setHidden(hidden: boolean) { if (hidden) this.panel?.dispose(); }
  dispose() { this.panel?.dispose(); }
}
