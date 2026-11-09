import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c
  );
function temperatureHtml(webview, context, token) {
  const asset = (name) =>
    escape(
      webview.asWebviewUri(
        vscode.Uri.joinPath(
          context.extensionUri,
          ...(name.endsWith('.js') ? ['dist', 'webviews', name] : ['media', name])
        )
      )
    );
  const nonce = randomBytes(18).toString('base64');
  return /* HTML */ `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${escape(
            webview.cspSource
          )}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';"
        />
        <link rel="stylesheet" href="${asset('temperature-chart.css')}" />
        <title>市场温度 · 当日走势</title>
      </head>
      <body data-token="${token}">
        <main>
          <div class="heading">
            <div>
              <h1>市场温度 <span id="date"></span></h1>
              <p id="status" role="status"></p>
            </div>
            <div id="current"></div>
          </div>
          <div class="summary" id="summary"></div>
          <div id="temperature-plot" tabindex="0" role="group" aria-label="市场温度当日走势图，左右方向键选择采集点">
            <svg id="temperature-svg" aria-hidden="true"></svg>
            <div id="temperature-tooltip" hidden></div>
          </div>
          <p id="temperature-detail">移动鼠标查看采集时间与温度分数。</p>
          <div class="legend">
            <span class="coldest">0–19 冰点</span><span class="cold">20–39 偏冷</span><span>40–59 中性</span
            ><span class="warm">60–79 偏热</span><span class="hot">80–100 过热</span>
          </div>
          <p class="note">
            盘中每分钟记录一次，相邻记录连成折线；缺采超过3分钟用虚线连接，午休留空。悬停只显示真实采样时间和分数，不补造中间数据。收盘确认合并为15:00端点，保留实际采集时间；午休及收盘后的手动刷新不追加记录。重启保留当天走势，次日清空。
          </p>
          <p class="note">
            鼠标悬停或左右方向键查看对应时间与分数，Esc或移出图表恢复最新记录。右上角可刷新行情、查看计算明细。市场温度为自定义0–100分情绪指标，计算口径沿用状态栏。
          </p>
        </main>
        <script nonce="${nonce}" src="${asset('temperature-chart.js')}"></script>
      </body>
    </html>`;
}
export { escape, temperatureHtml };
