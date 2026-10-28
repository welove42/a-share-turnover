'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
function setup(load) {
  const h = harness(); let now = new Date('2026-10-26T10:30:00+08:00'), calls = 0;
  const { ChartController } = h.load('../src/charts');
  const c = new ChartController(h.context, { now: () => now, provider: { load: async (...args) => { calls++; return load ? load(...args) : { symbol: args[0], mode: args[1], name: '测试股', bars: [{ close: 10 }] }; } } });
  return { ...h, c, calls: () => calls, setNow: time => { now = new Date(time); }, mode: (s, mode) => {
    if (!s.ready) c.receive(s, { action: 'ready', token: s.token });
    c.changeMode(s, mode);
    return c.receive(s, { action: 'mode-ready', mode, token: s.token });
  } };
}

test('首次详情默认内置分时，设置与显式类型可覆盖，HTML不预加载第三方网页', async () => {
  const h = setup(); try {
    await h.c.open('600105'); let s = h.c.panels.get('sh600105');
    assert.equal(s.mode, 'intraday'); assert.doesNotMatch(s.panel.webview.html, /<iframe[^>]+\ssrc=/);
    await h.mode(s, 'intraday'); assert.equal(h.calls(), 1);
    s.panel.dispose(); h.values.set('aShareTurnover.charts.defaultMode', 'daily');
    await h.c.open('600105'); s = h.c.panels.get('sh600105'); assert.equal(s.mode, 'daily');
    s.panel.dispose(); await h.c.open('600105', 'chips'); assert.equal(h.c.panels.get('sh600105').mode, 'chips');
  } finally { h.c.dispose(); }
});

test('快速切股再返回复用10秒内数据，缓存按股票和类型隔离，手动刷新限频', async () => {
  const h = setup(); try {
    await h.c.open('600105'); const s = h.c.panels.get('sh600105'); await h.mode(s, 'intraday');
    await h.c.open('000001'); await h.mode(s, 'intraday'); assert.equal(h.calls(), 2);
    await h.c.open('600105'); await h.mode(s, 'intraday'); assert.equal(h.calls(), 2);
    assert.equal(s.data.symbol, 'sh600105');
    await h.c.refreshActive(); assert.equal(h.calls(), 2);
    h.setNow('2026-10-26T10:30:02+08:00'); await h.c.refreshActive(); assert.equal(h.calls(), 3);
    await h.c.refreshActive(); assert.equal(h.calls(), 3);
    await h.mode(s, 'daily'); assert.equal(h.calls(), 4); assert.equal(s.data.mode, 'daily');
    await h.mode(s, 'intraday'); assert.equal(h.calls(), 4); assert.equal(s.data.mode, 'intraday');
    h.setNow('2026-10-26T10:30:12+08:00'); h.c.tick(); await s.inflight; assert.equal(h.calls(), 5);
  } finally { h.c.dispose(); }
});
test('同一个股复用图表标签，iframe模式不会每10秒重新加载网页', async () => {
  const h = setup(); try {
    await h.c.open('600519', 'eastmoney'); const state = h.c.panels.get('sh600519'), html = state.panel.webview.html;
    assert.match(html, /data-regular-url="https:\/\/quote\.eastmoney\.com\/basic\/full\.html\?mcid=1\.600519/);
    assert.doesNotMatch(html, /<iframe[^>]+\ssrc=/); assert.match(html, /frame-src https:\/\/quote\.eastmoney\.com/);
    await h.c.open({ symbol: 'sh600519' }); h.c.tick(); assert.equal(h.panels.length, 1); assert.equal(state.panel.revealCalls, 1); assert.equal(h.calls(), 0); assert.equal(state.panel.webview.html, html);
  } finally { h.c.dispose(); }
});
test('不同个股复用同一标签，保留筹码盘口模式；同一个股重复点击不重载', async () => {
  const h = setup(); try {
    await h.c.open('600105'); const s = h.c.panels.get('sh600105'), panel = s.panel;
    await h.mode(s, 'chips'); const token = s.token;
    await h.c.open('000001');
    assert.equal(h.panels.length, 1); assert.equal(h.c.panels.size, 1); assert.equal(h.c.panels.get('sz000001'), s);
    assert.equal(s.panel, panel); assert.equal(s.mode, 'chips'); assert.notEqual(s.token, token);
    assert.match(panel.webview.html, /h5chart-iframe\.html\?code=000001&amp;market=0/);
    const html = panel.webview.html;
    await h.c.open('000001'); h.c.tick(); assert.equal(panel.webview.html, html); assert.equal(h.calls(), 0);
    assert.equal(h.c.getState('sh600105'), undefined);
  } finally { h.c.dispose(); }
});
test('筹码模式切换指数或ETF时退回内置分时并禁用不支持的入口', async () => {
  const h = setup(); try {
    await h.c.open('600105', 'chips');
    await h.c.open('sh000001'); const s = h.c.panels.get('sh000001');
    assert.equal(s.mode, 'intraday'); assert.match(s.panel.webview.html, /data-chips-url=""/);
    await h.c.open('sh510300', 'chips'); assert.equal(s.mode, 'intraday');
    await h.c.open('bj920002', 'chips'); assert.equal(s.mode, 'intraday');
    assert.equal(h.panels.length, 1);
  } finally { h.c.dispose(); }
});
test('Webview尚未就绪时切换模式，以最后一次选择初始化且不重复加载同个股票', async () => {
  const h = setup(); try {
    await h.c.open('600105'); const s = h.c.panels.get('sh600105'), html = s.panel.webview.html;
    await h.c.open('600105', 'chips');
    assert.equal(s.ready, false); assert.equal(s.mode, 'chips'); assert.equal(s.panel.webview.html, html);
    h.c.receive(s, { action: 'ready', token: s.token });
    assert.equal(s.panel.webview.messages.at(-1).mode, 'chips');
    h.setNow('2026-10-26T10:31:00+08:00'); h.c.tick(); assert.equal(h.calls(), 0);
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
test('切换个股取消旧行情请求及旧页面消息，迟到结果不能覆盖新股票', async () => {
  const requests = [];
  const h = setup((symbol, mode, signal) => new Promise(resolve => requests.push({ symbol, signal, resolve })));
  try {
    await h.c.open('600105'); const s = h.c.panels.get('sh600105'), token = s.token;
    const old = h.mode(s, 'intraday');
    await h.c.open('000001'); assert.equal(requests[0].signal.aborted, true);
    await h.c.receive(s, { action: 'mode-ready', mode: 'chips', token }); assert.equal(s.mode, 'intraday');
    await h.c.receive(s, { action: 'external', token }); assert.equal(h.opened.length, 0);
    const current = h.mode(s, 'intraday');
    requests[1].resolve({ symbol: 'sz000001', mode: 'intraday', name: '平安银行', bars: [] }); await current;
    requests[0].resolve({ symbol: 'sh600105', mode: 'intraday', name: '过期永鼎', bars: [] }); await old;
    assert.equal(s.data.symbol, 'sz000001'); assert.equal(s.panel.title, '平安银行 · 行情');
    assert.equal(s.panel.webview.messages.filter(m => m.type === 'data').length, 1);
    s.panel.dispose(); assert.equal(h.c.panels.size, 0);
    await h.c.open('600105'); assert.equal(h.panels.length, 2); assert.equal(h.c.panels.size, 1);
  } finally { h.c.dispose(); }
});
test('iframe不能传入任意URL打开系统浏览器，消息令牌不匹配时忽略', async () => {
  const h = setup(); try {
    await h.c.open('sh000001', 'eastmoney'); const s = h.c.panels.get('sh000001');
    await h.c.receive(s, { action: 'external', token: 'wrong', url: 'https://evil.example' }); assert.equal(h.opened.length, 0);
    await h.c.receive(s, { action: 'external', token: s.token, url: 'https://evil.example' }); assert.deepEqual(h.opened, ['https://quote.eastmoney.com/basic/full.html?mcid=1.000001']);
    await h.c.open('600105', 'chips');
    await h.c.receive(s, { action: 'external', token: s.token, url: 'https://evil.example' });
    assert.equal(h.opened.at(-1), 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=600105&market=1');
    await h.c.open('https://evil.example'); assert.equal(h.panels.length, 1);
  } finally { h.c.dispose(); }
});

test('工具栏移除重复的内置周期，仅保留网页来源；网页可返回上次内置周期', async () => {
  const h = setup(); try {
    await h.c.open('600105'); const s = h.c.panels.get('sh600105');
    h.c.receive(s, { action: 'ready', token: s.token });
    h.c.changeMode(s, 'm15');
    let items;
    h.api.window.showQuickPick = async list => { items = list; return list.find(item => item.mode === 'chips'); };
    await h.c.chooseMode(); assert.equal(s.mode, 'chips');
    assert.deepEqual(items.map(item => item.mode), ['eastmoney', 'chips']);
    assert.equal(s.panel.webview.messages.at(-1).type, 'select-mode');
    h.api.window.showQuickPick = async list => { items = list; return undefined; };
    await h.c.chooseMode(); assert.equal(s.mode, 'chips');
    assert.deepEqual(items.map(item => item.mode), ['m15', 'eastmoney', 'chips']);
    assert.equal(items[0].label, '返回内置图表');
    assert.equal(items.find(item => item.mode === 'chips').description, '当前图表');
    h.api.window.showQuickPick = async list => list.find(item => item.label === '返回内置图表');
    await h.c.chooseMode(); assert.equal(s.mode, 'm15');
    h.c.changeMode(s, 'chips');
    h.api.window.showQuickPick = async list => { items = list; return undefined; };
    await h.c.open('sh000001'); await h.c.chooseMode();
    assert.equal(s.mode, 'intraday'); assert.equal(items.some(item => item.mode === 'chips'), false);
    assert.deepEqual(items.map(item => item.mode), ['eastmoney']);
    h.c.changeMode(s, 'eastmoney');
    h.api.window.showQuickPick = async list => list.find(item => item.label === '返回内置图表');
    await h.c.chooseMode(); assert.equal(s.mode, 'intraday');
    assert.doesNotMatch(s.panel.webview.html, /<header|<nav|id="hint"|id="refresh"|id="external"/);
  } finally { h.c.dispose(); }
});
test('类型菜单打开后切换个股或关闭详情，旧选择不影响新股票', async () => {
  const h = setup(); try {
    await h.c.open('600105'); const s = h.c.panels.get('sh600105'); let finish;
    h.api.window.showQuickPick = () => new Promise(resolve => { finish = resolve; });
    const pending = h.c.chooseMode(); await h.c.open('000001');
    finish({ mode: 'daily' }); await pending; assert.equal(s.mode, 'intraday');
    const closing = h.c.chooseMode(); s.panel.dispose();
    finish({ mode: 'chips' }); await closing; assert.equal(h.c.panels.size, 0);
  } finally { h.c.dispose(); }
});
test('右上角刷新和浏览器打开作用于当前详情股票；可见但未聚焦的分组也可使用', async () => {
  const h = setup(); try {
    await h.c.open('600105', 'chips'); const s = h.c.panels.get('sh600105');
    s.panel.active = false;
    h.c.refreshActive(); assert.equal(s.panel.webview.messages.length, 0);
    h.c.receive(s, { action: 'ready', token: s.token });
    assert.deepEqual(s.panel.webview.messages.slice(-2).map(m => m.type), ['select-mode', 'refresh']);
    assert.equal(h.calls(), 0);
    await h.c.openActiveExternal(); assert.match(h.opened.at(-1), /code=600105&market=1/);
    await h.c.open('000001', 'intraday'); await h.mode(s, 'intraday');
    const html = s.panel.webview.html;
    h.setNow('2026-10-26T10:30:02+08:00');
    await h.c.refreshActive(); assert.equal(h.calls(), 2); assert.equal(s.panel.webview.html, html);
    await h.c.openActiveExternal(); assert.match(h.opened.at(-1), /sz000001/);
    s.panel.setVisible(false); const messages = s.panel.webview.messages.length, opened = h.opened.length;
    await h.c.refreshActive(); await h.c.openActiveExternal();
    assert.equal(s.panel.webview.messages.length, messages); assert.equal(h.opened.length, opened);
  } finally { h.c.dispose(); }
});
test('快速切换类型后，迟到的页面确认不能恢复旧模式或请求旧行情', async () => {
  const h = setup(); try {
    await h.c.open('600105'); const s = h.c.panels.get('sh600105');
    h.c.receive(s, { action: 'ready', token: s.token });
    h.c.changeMode(s, 'daily'); h.c.changeMode(s, 'chips');
    await h.c.receive(s, { action: 'mode-ready', mode: 'daily', token: s.token });
    assert.equal(s.mode, 'chips'); assert.equal(h.calls(), 0);
  } finally { h.c.dispose(); }
});

test('指标默认MACD，右上角切换不请求行情，跨股票及重开保留并拒绝迟到选择', async () => {
  const h = setup(); try {
    await h.c.open('600105', 'weekly'); const s = h.c.panels.get('sh600105'); await h.mode(s, 'weekly');
    assert.equal(h.c.getState('sh600105').indicator, 'macd');
    const before = h.calls();
    h.api.window.showQuickPick = async items => items.find(item => item.indicator === 'rsi');
    await h.c.chooseIndicator(); assert.equal(h.calls(), before);
    assert.equal(s.panel.webview.messages.at(-1).type, 'select-indicator'); assert.equal(h.store.get('chartIndicator'), 'rsi');
    await h.c.open('000001'); await h.mode(s, 'weekly');
    assert.equal(h.c.getState('sz000001').indicator, 'rsi');
    let finish; h.api.window.showQuickPick = () => new Promise(resolve => { finish = resolve; });
    const pending = h.c.chooseIndicator(); await h.c.open('600105', 'monthly');
    finish({ indicator: 'kdj' }); await pending; assert.equal(h.c.indicator, 'rsi');
    s.panel.dispose(); await h.c.open('000001', 'monthly');
    assert.equal(h.c.getState('sz000001').indicator, 'rsi');
  } finally { h.c.dispose(); }
});

test('页面切周期同步宿主并取消旧请求，重复点击不重载，拒绝旧股票和非法周期', async () => {
  const h = setup(); try {
    await h.c.open('600105'); const s = h.c.panels.get('sh600105'); await h.mode(s, 'intraday');
    const html = s.panel.webview.html, token = s.token;
    h.c.receive(s, { action: 'period', mode: 'weekly', token });
    assert.equal(s.mode, 'weekly'); assert.equal(s.panel.webview.html, html);
    await h.c.receive(s, { action: 'mode-ready', mode: 'weekly', token });
    const calls = h.calls(), messages = s.panel.webview.messages.length;
    h.c.receive(s, { action: 'period', mode: 'weekly', token }); assert.equal(h.calls(), calls); assert.equal(s.panel.webview.messages.length, messages);
    for (const mode of ['chips', 'eastmoney', 'https://evil.example']) h.c.receive(s, { action: 'period', mode, token });
    assert.equal(s.mode, 'weekly');
    h.c.receive(s, { action: 'period', mode: 'monthly', token }); h.c.receive(s, { action: 'period', mode: 'intraday', token });
    await h.c.receive(s, { action: 'mode-ready', mode: 'monthly', token }); assert.equal(h.calls(), calls);
    await h.c.open('000001'); h.c.receive(s, { action: 'period', mode: 'monthly', token }); assert.equal(s.mode, 'intraday');
  } finally { h.c.dispose(); }
});
