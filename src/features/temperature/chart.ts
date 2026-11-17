import { escape, temperatureHtml } from './view';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { TemperatureDisplayMode } from './breadth';
class TemperatureChartController {
  declare context: any;
  declare data: any;
  declare state: {
    panel: vscode.WebviewPanel;
    token: string;
    ready: boolean;
    sent: string;
    listeners?: vscode.Disposable[];
  } | null;
  declare disposed: boolean;
  declare setDisplayMode: (mode: TemperatureDisplayMode) => Promise<void>;

  constructor(context, data, setDisplayMode: (mode: TemperatureDisplayMode) => Promise<void> = async () => {}) {
    this.context = context;
    this.data = data;
    this.state = null;
    this.disposed = false;
    this.setDisplayMode = setDisplayMode;
  }
  open() {
    if (this.disposed) return;
    if (this.state) {
      this.state.panel.reveal();
      this.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'welove42.aShareTurnover.temperatureChart',
      '市场温度 · 当日走势',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews')
        ]
      }
    );
    const state: NonNullable<TemperatureChartController['state']> = (this.state = {
      panel,
      token: randomBytes(24).toString('hex'),
      ready: false,
      sent: ''
    });
    state.listeners = [
      panel.webview.onDidReceiveMessage((message) => {
        if (this.state !== state || message?.token !== state.token) return;
        if (message.action === 'ready') {
          state.ready = true;
          this.update(true);
        } else if (
          state.ready &&
          message.action === 'set-display-mode' &&
          ['temperature', 'breadth'].includes(message.mode)
        ) {
          void this.setDisplayMode(message.mode).then(
            () => {
              if (this.state !== state) return;
              this.update(true);
              void panel.webview.postMessage({ type: 'temperature-mode-result', token: state.token, ok: true });
            },
            () => {
              if (this.state !== state) return;
              void panel.webview.postMessage({
                type: 'temperature-mode-result',
                token: state.token,
                ok: false,
                error: '保存失败，请重试或在插件设置中修改。'
              });
            }
          );
        }
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.update();
      }),
      panel.onDidDispose(() => {
        if (this.state === state) this.state = null;
        state.listeners?.forEach((listener) => listener.dispose());
      })
    ];
    panel.webview.html = temperatureHtml(panel.webview, this.context, state.token);
  }
  update(force = false) {
    const state = this.state;
    if (this.disposed || !state?.ready || !state.panel.visible) return;
    const data = this.data(),
      key = JSON.stringify(data);
    if (!force && key === state.sent) return;
    state.sent = key;
    void Promise.resolve(state.panel.webview.postMessage({ type: 'temperature-data', token: state.token, data })).catch(
      () => {}
    );
  }
  dispose() {
    this.disposed = true;
    this.state?.panel.dispose();
  }
}
export { TemperatureChartController, temperatureHtml };
