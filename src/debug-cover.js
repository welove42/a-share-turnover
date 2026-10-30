'use strict';
function debugCoverHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">
<style>
  body{padding:0 20px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);}
  main{padding-top:12px;max-width:480px;margin:auto;} p{line-height:1.5;margin:0 0 16px;}
  button{display:block;width:100%;border:1px solid transparent;border-radius:2px;padding:5px 12px;margin:0 0 14px;cursor:pointer;font:inherit;text-align:center;color:var(--vscode-button-foreground);background:var(--vscode-button-background);}
  button:hover{background:var(--vscode-button-hoverBackground)} button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
  .secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
  .secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
</style></head><body><main>
<p>运行和调试可帮助你发现和修复代码中的问题。</p>
<button type="button" data-action="start">运行和调试</button>
<p>若要配置调试器，请创建 launch.json 文件。</p>
<button type="button" class="secondary" data-action="configure">创建调试配置</button>
</main></body></html>`;
}

class DebugCoverProvider {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: false };
    view.webview.html = debugCoverHtml();
  }
}
module.exports = { DebugCoverProvider, debugCoverHtml };
