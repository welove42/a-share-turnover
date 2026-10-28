'use strict';
const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function temperatureHtml(webview, context, token) {
  const asset = name => escape(webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name)));
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(webview.cspSource)}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${asset('temperature-chart.css')}"><title>市场温度 · 当日走势</title></head><body data-token="${token}"><main>
<div class="heading"><div><h1>市场温度 <span id="date"></span></h1><p id="status" role="status"></p></div><div id="current"></div></div>
<div class="summary" id="summary"></div>
<div id="temperature-plot" tabindex="0" role="group" aria-label="市场温度当日走势图，左右方向键选择采集点"><svg id="temperature-svg" aria-hidden="true"></svg><div id="temperature-tooltip" hidden></div></div>
<p id="temperature-detail">移动鼠标查看采集时间与温度分数。</p>
<div class="legend"><span class="coldest">0–19 冰点</span><span class="cold">20–39 偏冷</span><span>40–59 中性</span><span class="warm">60–79 偏热</span><span class="hot">80–100 过热</span></div>
<p class="note">横轴为北京时间的本机采集时刻；仅记录启用功能后成功获取的真实温度，每10秒最多保留一个点。启用前、断网或暂停期间不补数据，间断超过1分钟会断开曲线。重启保留当天记录，次日自动清空。午休/收盘后的手动查询会标注为快照。</p>
<p class="note">鼠标悬停或左右方向键查看对应时间与分数，Esc或移出图表恢复最新记录。右上角可刷新行情、查看计算明细。市场温度为自定义0–100分情绪指标，计算口径沿用状态栏。</p>
</main><script nonce="${nonce}" src="${asset('temperature-model.js')}"></script><script nonce="${nonce}" src="${asset('temperature-chart.js')}"></script></body></html>`;
}
class TemperatureChartController {
  constructor(context, data) { this.context = context; this.data = data; this.state = null; this.disposed = false; }
  open() {
    if (this.disposed) return;
    if (this.state) { this.state.panel.reveal(); this.update(); return; }
    const panel = vscode.window.createWebviewPanel('welove42.aShareTurnover.temperatureChart', '市场温度 · 当日走势', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    const state = this.state = { panel, token: randomBytes(24).toString('hex'), ready: false, sent: '' };
    state.listeners = [panel.webview.onDidReceiveMessage(message => {
      if (this.state !== state || message?.token !== state.token || message.action !== 'ready') return;
      state.ready = true; this.update(true);
    }), panel.onDidChangeViewState(() => { if (panel.visible) this.update(); }), panel.onDidDispose(() => {
      if (this.state === state) this.state = null;
      state.listeners.forEach(listener => listener.dispose());
    })];
    panel.webview.html = temperatureHtml(panel.webview, this.context, state.token);
  }
  update(force = false) {
    const state = this.state;
    if (this.disposed || !state?.ready || !state.panel.visible) return;
    const data = this.data(), key = JSON.stringify(data);
    if (!force && key === state.sent) return;
    state.sent = key;
    void Promise.resolve(state.panel.webview.postMessage({ type: 'temperature-data', token: state.token, data })).catch(() => {});
  }
  dispose() { this.disposed = true; this.state?.panel.dispose(); }
}
module.exports = { TemperatureChartController, temperatureHtml };
