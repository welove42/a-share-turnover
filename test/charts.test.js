'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
function setup(load) {
  const h = harness(); let now = new Date('2026-10-26T10:30:00+08:00'), calls = 0;
  const { ChartController } = h.load('../src/charts');
  const c = new ChartController(h.context, { now: () => now, provider: { load: async (...args) => { calls++; return load ? load(...args) : { symbol: args[0], mode: args[1], name: '测试股', bars: [{ close: 10 }] }; } } });
  return { ...h, c, calls: () => calls, setNow: time => { now = new Date(time); }, mode: (s, mode) => c.receive(s, { action: 'mode', mode, token: s.token }) };
}
test('同一个股复用图表标签，iframe模式不会每10秒重新加载网页', async () => {
  const h = setup(); try {
    await h.c.open('600519'); const state = h.c.panels.get('sh600519'), html = state.panel.webview.html;
    assert.match(html, /<iframe[^>]+https:\/\/quote\.eastmoney\.com\/sh600519\.html/); assert.match(html, /frame-src https:\/\/quote\.eastmoney\.com/);
    await h.c.open({ symbol: 'sh600519' }); h.c.tick(); assert.equal(h.panels.length, 1); assert.equal(state.panel.revealCalls, 1); assert.equal(h.calls(), 0); assert.equal(state.panel.webview.html, html);
  } finally { h.c.dispose(); }
});
test('插件内图表交易期间10秒轮询，可见性和午休暂停，刷新仅发消息不替换HTML', async () => {
  const h = setup(); try {
    await h.c.open('600519'); const s = h.c.panels.get('sh600519'), html = s.panel.webview.html;
    await h.mode(s, 'intraday'); assert.equal(h.calls(), 1);
    h.setNow('2026-10-26T10:30:09+08:00'); h.c.tick(); assert.equal(h.calls(), 1);
    h.setNow('2026-10-26T10:30:10+08:00'); h.c.tick(); await s.inflight; assert.equal(h.calls(), 2);
    s.panel.setVisible(false); h.setNow('2026-10-26T10:30:20+08:00'); h.c.tick(); assert.equal(h.calls(), 2);
    s.panel.setVisible(true); await s.inflight; assert.equal(h.calls(), 3);
    h.setNow('2026-10-26T12:00:00+08:00'); h.c.tick(); assert.equal(h.calls(), 3);
    assert.equal(s.panel.webview.html, html); assert.ok(s.panel.webview.messages.some(m => m.type === 'data'));
  } finally { h.c.dispose(); }
});
test('切换图表类型取消旧请求，迟到结果不覆盖新图，关闭标签释放资源', async () => {
  const requests = [];
  const h = setup((symbol, mode, signal) => new Promise(resolve => requests.push({ mode, signal, resolve })));
  try {
    await h.c.open('600519'); const s = h.c.panels.get('sh600519');
    const first = h.mode(s, 'intraday'), second = h.mode(s, 'daily'); assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve({ name: '测试股', mode: 'daily' }); await second;
    requests[0].resolve({ name: '迟到旧数据', mode: 'intraday' }); await first;
    assert.equal(s.data.mode, 'daily'); assert.equal(s.panel.webview.messages.filter(m => m.type === 'data').length, 1);
    s.panel.dispose(); assert.equal(h.c.panels.size, 0);
  } finally { h.c.dispose(); }
});
test('iframe不能传入任意URL打开系统浏览器，消息令牌不匹配时忽略', async () => {
  const h = setup(); try {
    await h.c.open('sh000001'); const s = h.c.panels.get('sh000001');
    await h.c.receive(s, { action: 'external', token: 'wrong', url: 'https://evil.example' }); assert.equal(h.opened.length, 0);
    await h.c.receive(s, { action: 'external', token: s.token, url: 'https://evil.example' }); assert.deepEqual(h.opened, ['https://quote.eastmoney.com/zs000001.html']);
    await h.c.open('https://evil.example'); assert.equal(h.panels.length, 1);
  } finally { h.c.dispose(); }
});
