import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { escape } from '../temperature/view';

export function calendarHtml(webview: vscode.Webview, context: vscode.ExtensionContext, token: string) {
  const asset = (name: string) => escape(webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,
    ...(name.endsWith('.js') ? ['dist', 'webviews', name] : ['media', name]))));
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(webview.cspSource)}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${asset('event-calendar.css')}"><title>财经大事日历</title></head>
  <body data-token="${token}"><main><header><div><h1>财经大事日历</h1><p>关注重要经济数据、会议和交易所休市安排</p></div><button id="refresh" type="button">刷新数据</button></header>
  <div class="toolbar"><div class="filter-group"><label for="filter">事件类型</label><select id="filter"><option value="all">全部事件</option><option value="fed">美联储议息</option><option value="delivery">股指交割</option><option value="cnHoliday">A股休市</option><option value="hkHoliday">港股休市</option><option value="usHoliday">美股休市</option><option value="nonfarm">美国非农</option><option value="cpi">美国CPI</option></select></div><div class="month-nav"><button id="prev" type="button" aria-label="上个月">‹</button><input id="month" type="month" min="1900-01" max="2100-12" aria-label="选择年月"><button id="next" type="button" aria-label="下个月">›</button><button id="today" type="button">今天</button></div></div>
  <div class="calendar" aria-label="月历"><div class="weekdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div id="days" class="days"></div></div>
  <section class="details"><h2 id="date-title">当天事件</h2><div id="events"></div></section><p class="footnote" id="status" role="status">正在加载…</p><p class="footnote">定时事件按北京时间显示，休市按交易所当地日期显示。数据可能使用缓存或快照，未显示事件不代表没有安排，具体以官方公告为准。</p></main><script nonce="${nonce}" src="${asset('event-calendar.js')}"></script></body></html>`;
}
