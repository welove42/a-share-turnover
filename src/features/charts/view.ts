import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { ChartProvider, eastmoneyUrl, eastmoneyChartUrl, supportsChips } from './data';

const MINUTE_MODES = ['m1', 'm5', 'm15', 'm30', 'm60'];
const MODES = ['eastmoney', 'chips', 'intraday', 'intraday5', ...MINUTE_MODES, 'daily', 'weekly', 'monthly'];
const INDICATORS = ['macd', 'kdj', 'rsi', 'none'];
const isWebMode = (mode) => mode === 'eastmoney' || mode === 'chips';
const availableMode = (symbol, mode) =>
  MODES.includes(mode) && (mode !== 'chips' || supportsChips(symbol)) ? mode : 'intraday';
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c
  );
function chartHtml(webview, context, symbol, token, mode = 'intraday') {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chart.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'chart.js'));
  mode = availableMode(symbol, mode);
  const regularUrl = eastmoneyChartUrl(symbol),
    chipsUrl = supportsChips(symbol) ? eastmoneyChartUrl(symbol, 'chips') : '';
  const nonce = randomBytes(18).toString('base64');
  const periods = [
    ['intraday', '分时'],
    ['intraday5', '5日分时'],
    ...MINUTE_MODES.map((value) => [value, `${value.slice(1)}分钟`]),
    ['daily', '日K'],
    ['weekly', '周K'],
    ['monthly', '月K']
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-period="${value}" aria-pressed="${mode === value}">${label}</button>`
    )
    .join('');
  const indicatorButtons = [
    ['macd', 'MACD'],
    ['kdj', 'KDJ'],
    ['rsi', 'RSI'],
    ['none', '隐藏']
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-indicator="${value}" aria-pressed="${value === 'macd'}" aria-controls="indicator-guide">${label}</button>`
    )
    .join('');
  return /* HTML */ `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; frame-src https://quote.eastmoney.com; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; base-uri 'none'; form-action 'none';"
        />
        <link rel="stylesheet" href="${escapeHtml(css)}" />
        <title>${escapeHtml(symbol)} 行情图表</title>
      </head>
      <body
        data-symbol="${escapeHtml(symbol)}"
        data-token="${token}"
        data-regular-url="${escapeHtml(regularUrl)}"
        data-chips-url="${escapeHtml(chipsUrl)}"
        data-mode="${escapeHtml(mode)}"
      >
        <main>
          <div id="web-chart" ${isWebMode(mode) ? '' : ' hidden'}>
            <iframe
              id="eastmoney"
              title="东方财富 ${escapeHtml(symbol)} 专用图表"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerpolicy="strict-origin-when-cross-origin"
            ></iframe>
          </div>
          <section id="local" ${isWebMode(mode) ? ' hidden' : ''} aria-label="插件内行情图表">
            <div class="chart-tools"><span id="quote"></span><span id="turnover"></span></div>
            <div class="selected-details" aria-label="行情明细">
              <div id="detail">移动鼠标查看价格、成交量与指标。</div>
              <p id="history-status" role="status"></p>
              <p id="average-detail"></p>
              <p id="indicator-detail"></p>
            </div>
            <div class="chart-toolbar">
              <div class="period-tools" role="group" aria-label="图表周期">${periods}</div>
              <div id="zoom-tools" class="zoom-tools" role="group" aria-label="K线缩放" hidden>
                <button type="button" id="zoom-in" aria-label="放大K线" title="放大K线（Ctrl + 滚轮向上）">＋</button
                ><button type="button" id="zoom-out" aria-label="缩小K线" title="缩小K线（Ctrl + 滚轮向下）">−</button>
              </div>
            </div>
            <p id="meta"></p>
            <p id="status" role="status" aria-live="polite"></p>
            <div id="plot" tabindex="0" role="group" aria-label="行情价格、成交量及技术指标">
              <svg id="svg" viewBox="0 0 1040 500" aria-hidden="true"></svg>
              <div id="indicator-controls" class="indicator-tools" role="group" aria-label="副图指标">
                <span class="tool-label">副图</span>${indicatorButtons}
              </div>
              <div id="indicator-chart"><svg id="indicator-svg" viewBox="0 0 1040 220" aria-hidden="true"></svg></div>
              <aside id="indicator-guide" aria-label="指标读图说明">
                <strong id="indicator-guide-title"></strong>
                <p id="indicator-guide-body"></p>
                <p id="indicator-guide-context"></p>
              </aside>
              <div id="chart-tooltip" hidden></div>
            </div>
            <p class="note" id="indicator-note"></p>
            <p class="note">
              在顶部切换周期，成交量下方切换副图指标。分时黄色线为当日成交均价；5日分时按交易日分区，均价与副图指标每日重置，历史日期缺少昨收时涨跌幅显示为空。成交量柱高按所显示周期线性缩放；分时柱颜色按相邻分钟价格涨跌判断，首分钟参考昨收，缺少参考价或价格不变显示中性色。K线换手率为对应周期值，5日分时显示当日全天换手率（最后一天为数据源最新值）；来源东方财富，沪深日周月K及5日分时可使用搜狐备用；数据缺失时显示“—”。K线含
              MA5 / MA10 / MA20 / MA30 / MA60，成交量含 VMA5 /
              VMA10，周期按当前K线根数计算。鼠标或左右键定位可同步查看均线、MACD / KDJ /
              RSI。分钟K线时间为周期结束时间，最后一根可能尚未完成；成交量单位为手，时间为北京时间。可见且交易期间每10秒刷新。
            </p>
          </section>
        </main>
        <script nonce="${nonce}" src="${escapeHtml(js)}"></script>
      </body>
    </html>`;
}
export { MINUTE_MODES, MODES, INDICATORS, isWebMode, availableMode, escapeHtml, chartHtml };
