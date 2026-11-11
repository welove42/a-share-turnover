import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { escape } from '../temperature/view';
export function boardHtml(webview: any, context: any, token: string) {
  const asset = (name: string) =>
    escape(
      webview.asWebviewUri(
        vscode.Uri.joinPath(
          context.extensionUri,
          ...(name.endsWith('.js') ? ['dist', 'webviews', name] : ['media', name])
        )
      )
    );
  const nonce = randomBytes(18).toString('base64');
  const pagination = `<div class="pagination" role="navigation" aria-label="板块列表分页"><button type="button" data-page="previous" aria-label="上一页" disabled>上一页</button><span data-page-info aria-live="polite">0 / 0 页</span><button type="button" data-page="next" aria-label="下一页" disabled>下一页</button></div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(webview.cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${asset('sector-board.css')}"><title>板块行情</title></head>
  <body data-token="${token}"><main><header><div><h1>板块行情</h1><p>行业与概念的涨跌和成交情况</p></div><button id="refresh" title="刷新板块数据">刷新</button></header>
  <nav aria-label="板块选择"><div class="tabs" id="categories"><button data-category="industry">行业板块</button><button data-category="concept">概念板块</button></div><div class="tabs" id="directions"><button data-direction="gainers">涨幅排行</button><button data-direction="losers">跌幅排行</button></div><div class="tabs" id="views"><button data-view="table">列表</button><button data-view="heatmap">热点云图</button></div></nav>
  <p id="status" role="status">正在获取板块数据…</p><div id="summary" class="summary"></div>
  <section id="table-view"><div class="toolbar"><input id="search" placeholder="搜索全部板块名称或代码" maxlength="40" aria-label="搜索全部板块"><div class="page-tools"><span id="count"></span>${pagination}</div></div><div class="table-wrap"><table><thead><tr><th>排名</th><th>板块</th><th><button data-sort="percent">涨跌幅 ↕</button></th><th><button data-sort="amount">成交额 ↕</button></th><th><button data-sort="volume">成交量 ↕</button></th><th>换手率</th><th>上涨/下跌</th><th>领涨股</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pagination-bottom">${pagination}</div></section>
  <section id="heatmap-view" hidden><div class="toolbar"><p>面积代表板块成交额，颜色代表涨跌幅；悬停或点击方块可查看板块详情。</p><span id="coverage"></span></div><div id="heatmap" class="heatmap" aria-label="板块热点云图"></div><p class="note">红涨绿跌，颜色越鲜明涨跌幅越大。较小方块隐藏文字，悬停可查看完整数据；其他板块可在列表中查看。</p></section>
  <aside id="detail" hidden></aside><p class="note">板块分类、行情及时间以数据源为准，可能延迟；板块之间可能包含相同成分股，成交额不宜直接相加。</p></main><script nonce="${nonce}" src="${asset('sector-board.js')}"></script></body></html>`;
}
