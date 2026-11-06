import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

function settingsHtml(webview, context, token) {
  const uri = (name) =>
    webview.asWebviewUri(
      vscode.Uri.joinPath(
        context.extensionUri,
        ...(name.endsWith('.js') ? ['dist', 'webviews', name] : ['media', name])
      )
    );
  const nonce = randomBytes(18).toString('base64');
  return /* HTML */ `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';"
        />
        <link rel="stylesheet" href="${uri('settings.css')}" />
        <title>行情设置</title>
      </head>
      <body data-token="${token}">
        <header>
          <div>
            <h1>行情设置</h1>
            <p>按你的习惯安排看盘。</p>
          </div>
          <span id="save-status" role="status" aria-live="polite">正在加载…</span>
        </header>
        <div class="layout">
          <nav id="categories" aria-label="设置分类"></nav>
          <main>
            <label class="search"
              ><span>搜索设置</span
              ><input id="search" type="search" placeholder="搜索设置，例如：板块、图表、提醒" autocomplete="off"
            /></label>
            <p class="hint">常规设置自动保存 · AI 配置需保存 · 老板键 Ctrl+Shift+; 可隐藏行情和设置页</p>
            <p id="dependencies" role="status"></p>
            <div id="sections"></div>
            <p id="empty" hidden>没有匹配的设置</p>
          </main>
        </div>
        <script nonce="${nonce}" src="${uri('settings.js')}"></script>
      </body>
    </html>`;
}
export { settingsHtml };
