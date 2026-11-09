import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';

function html(webview: vscode.Webview, context: vscode.ExtensionContext, token: string) {
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
        <link rel="stylesheet" href="${uri('ai-analysis.css')}" />
        <title>AI 分析</title>
      </head>
      <body data-token="${token}">
        <header>
          <div><strong>AI 分析</strong><span id="model"></span></div>
          <div class="header-actions">
            <button id="history" class="quiet" title="恢复本地保存的分析对话">历史</button
            ><button id="diagnostics" class="quiet" title="查看最近请求的耗时和结束原因">诊断</button
            ><button id="settings" class="quiet" title="配置 API 地址、模型和密钥">设置</button>
          </div>
        </header>
        <section class="target">
          <div id="target-picker" class="target-picker">
            <button
              id="choose"
              type="button"
              class="target-button"
              title="选择自选股或大盘"
              aria-expanded="false"
              aria-controls="target-menu"
              aria-haspopup="listbox"
            >
              <span id="target">选择分析对象</span><span class="target-chevron" aria-hidden="true"></span>
            </button>
            <div id="target-menu" class="target-menu" hidden>
              <input
                id="target-search"
                type="search"
                role="combobox"
                aria-label="搜索分析对象"
                aria-controls="target-options"
                aria-expanded="false"
                aria-autocomplete="list"
                placeholder="搜索自选名称或代码"
                autocomplete="off"
                spellcheck="false"
                maxlength="100"
              />
              <div id="target-options" role="listbox" aria-label="自选股与大盘"></div>
              <p id="target-empty" role="status" hidden>没有匹配的自选股或大盘</p>
            </div>
          </div>
          <div class="toolbar">
            <button id="analyze">开始分析</button><button id="stop" class="secondary" hidden>停止</button
            ><button id="clear" class="quiet" title="删除当前这段本地对话">清空</button>
          </div>
        </section>
        <p id="status" role="status" aria-live="polite"></p>
        <p id="save-warning" role="status" hidden></p>
        <p id="context-summary" hidden aria-label="分析上下文"></p>
        <main id="conversation" tabindex="0" aria-label="分析内容">
          <div id="welcome">
            <h2>边写代码，边看分析</h2>
            <p>选择个股、场内 ETF 或大盘，结合月线、周线、日线、分时及市场环境分析。</p>
            <p>先看整体判断，再看各周期走势、观察条件和主要风险。缺失数据会标明。</p>
            <p>首次使用，在设置中填写 API 地址、模型和 Key。</p>
            <p class="muted">仅点击分析、追问或测试连接时调用，由你的 API 服务商计费。</p>
          </div>
          <div id="messages"></div>
        </main>
        <details id="snapshot" hidden>
          <summary>本次行情数据</summary>
          <pre id="data"></pre>
        </details>
        <form id="followup">
          <label for="question">继续追问</label>
          <div class="composer">
            <textarea
              id="question"
              aria-describedby="followup-hint"
              rows="3"
              maxlength="2000"
              placeholder="继续问点什么，例如：目前有哪些风险？"
            ></textarea>
            <div class="composer-actions">
              <span class="composer-shortcut">Ctrl / ⌘ + Enter 发送</span><button id="send" type="submit">发送</button>
            </div>
          </div>
          <p id="followup-hint" class="muted" role="status"></p>
        </form>
        <footer>
          对话自动保存在本机，可从“历史”恢复或删除。<br />仅发送公开行情、快讯和本次对话，不读取代码或持仓。<br />AI
          可能有误，分析仅供参考。
        </footer>
        <aside id="history-panel" hidden aria-label="AI 分析历史">
          <div class="history-heading">
            <strong>历史记录</strong><button id="historyClose" class="quiet" title="返回分析">关闭</button>
          </div>
          <p class="history-caption">保存在本机，点击继续对话。最多保留20段。</p>
          <div id="history-list"></div>
          <p id="history-empty" class="muted" hidden>暂无历史记录。</p>
          <div id="history-confirm" hidden role="alert">
            <p id="history-confirm-text"></p>
            <button id="history-confirm-delete" class="secondary">确认删除</button
            ><button id="history-cancel-delete" class="quiet">取消</button>
          </div>
          <button id="history-delete-all" class="quiet history-delete-all">清空全部历史</button>
        </aside>
        <script nonce="${nonce}" src="${uri('ai-analysis.js')}"></script>
      </body>
    </html>`;
}
export { html };
