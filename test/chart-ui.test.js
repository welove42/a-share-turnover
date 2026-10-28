'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function page({ mode = 'intraday', chips = true, saved = {} } = {}) {
  const nodes = new Map(), messages = [], receivers = [], writes = [], timers = new Map();
  let now = 0, nextTimer = 0;
  const advance = ms => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
  let body;
  function node(id, dataset = {}) {
    const attrs = new Map(), listeners = new Map();
    const value = { tag: id, children: [], dataset, style: {}, classList: { add() {} }, hidden: false,
      setAttribute(key, data) { attrs.set(key, String(data)); }, getAttribute: key => attrs.get(key) ?? null,
      removeAttribute: key => attrs.delete(key), replaceChildren(...items) { this.children = items; }, append(...items) { this.children.push(...items); },
      dispatch(key, event = {}) { for (const fn of listeners.get(key) || []) fn({ target: value, preventDefault() {}, ...event }); },
      addEventListener(key, fn) { if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); },
      click() { for (const fn of listeners.get('click') || []) fn({ target: value }); if (value !== body) body.click(); }
    };
    Object.defineProperty(value, 'src', { get: () => attrs.get('src'), set: url => { attrs.set('src', url); writes.push(url); } });
    nodes.set(id, value); return value;
  }
  body = node('body', { symbol: 'sh600105', token: 'test-token', mode,
    regularUrl: 'https://quote.eastmoney.com/basic/full.html?mcid=1.600105',
    chipsUrl: chips ? 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=600105&market=1' : '' });
  const buttons = Object.fromEntries(['intraday', 'm1', 'm5', 'm15', 'm30', 'm60', 'daily', 'weekly', 'monthly'].map(period => [period, node(period, { period })]));
  const document = { body, getElementById: id => nodes.get(id) || node(id),
    createElementNS: (_, tag) => node(tag), createDocumentFragment: () => node('fragment'),
    querySelectorAll: selector => selector === 'button[data-period]' ? Object.values(buttons) : [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/chart.js'), 'utf8'), {
    document, marketIndicators: require('../media/indicators'), window: { addEventListener: (event, fn) => { if (event === 'message') receivers.push(fn); } },
    Date: { now: () => now }, setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: id => timers.delete(id),
    acquireVsCodeApi: () => ({ getState: () => saved, setState() {}, postMessage: message => messages.push(message) })
  });
  return { nodes, buttons, messages, writes, advance, receive: message => receivers.forEach(fn => fn({ data: { token: 'test-token', ...message } })) };
}

test('编辑器切换网页图表合并快速选择，重复选择不重载，连续刷新限频', () => {
  const p = page(); p.receive({ type: 'select-mode', mode: 'chips' });
  assert.equal(p.writes.length, 0); p.advance(400);
  assert.match(p.nodes.get('eastmoney').src, /h5chart-iframe/);
  assert.equal(p.messages.filter(m => m.action === 'mode-ready').length, 1);
  assert.equal(p.messages.at(-1).mode, 'chips');
  const writes = p.writes.length; p.receive({ type: 'select-mode', mode: 'chips' }); assert.equal(p.writes.length, writes);
  p.receive({ type: 'refresh', mode: 'chips' }); p.advance(400); assert.equal(p.writes.length, writes);
  p.advance(5000); p.receive({ type: 'refresh', mode: 'chips' }); p.receive({ type: 'refresh', mode: 'chips' });
  p.advance(400); assert.equal(p.writes.length, writes + 1);
  p.receive({ type: 'refresh', mode: 'eastmoney' }); assert.equal(p.writes.length, writes + 1);
  p.receive({ type: 'select-mode', mode: 'eastmoney' }); p.advance(400); assert.match(p.nodes.get('eastmoney').src, /full\.html/);
});

const sampleBars = Array.from({ length: 240 }, (_, i) => ({ time: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, open: 10 + i * .01, close: 10 + i * .01 + Math.sin(i) * .2, high: 11 + i * .01, low: 9 + i * .01, volume: 100 + i }));
const descendants = item => [item, ...item.children.flatMap(descendants)];

test('日周月均绘制K线与默认MACD，切换指标无需网络，跨周期保留选择', () => {
  const p = page();
  for (const mode of ['daily', 'weekly', 'monthly']) {
    p.receive({ type: 'select-mode', mode });
    p.receive({ type: 'data', data: { symbol: 'sh600105', name: '测试股', source: '测试', mode, date: '2026-10-28', adjustment: '前复权', bars: sampleBars } });
    assert.equal(p.nodes.get('range-label').hidden, false);
    assert.match(p.nodes.get('meta').textContent, new RegExp({ daily: '日K', weekly: '周K', monthly: '月K' }[mode]));
    assert.ok(descendants(p.nodes.get('svg')).some(n => n.getAttribute('class') === 'indicator-bar'));
    assert.doesNotMatch(JSON.stringify(descendants(p.nodes.get('svg')).map(n => n.getAttribute('points'))), /NaN|Infinity/);
  }
  const messages = p.messages.length;
  p.receive({ type: 'select-indicator', indicator: 'rsi' });
  assert.match(p.nodes.get('indicator-detail').textContent, /RSI6.*RSI12.*RSI24/);
  const latest = p.nodes.get('indicator-detail').textContent;
  p.nodes.get('plot').dispatch('keydown', { key: 'ArrowLeft' });
  assert.notEqual(p.nodes.get('indicator-detail').textContent, latest);
  p.nodes.get('range').value = '60'; p.nodes.get('range').dispatch('change');
  assert.equal(p.nodes.get('indicator-detail').textContent, latest);
  p.receive({ type: 'select-indicator', indicator: 'none' });
  assert.equal(p.nodes.get('indicator-detail').textContent, ''); assert.equal(p.nodes.get('svg').getAttribute('viewBox'), '0 0 1040 550');
  assert.equal(p.messages.length, messages); assert.equal(p.writes.length, 0);
});

test('短分时KDJ提示数据不足、RSI无无效数值，旧股票消息不覆盖当前图', () => {
  const p = page(); p.receive({ type: 'select-mode', mode: 'intraday' });
  p.receive({ type: 'data', data: { symbol: 'sh600105', mode: 'intraday', name: '测试股', source: '测试', date: '2026-10-28', previousClose: 10, bars: [{ ...sampleBars[0], time: '0930' }] } });
  p.receive({ type: 'select-indicator', indicator: 'kdj' });
  assert.ok(descendants(p.nodes.get('svg')).some(n => /数据不足/.test(n.textContent)));
  assert.match(p.nodes.get('indicator-note').textContent, /不代表完整1分钟K线/);
  p.receive({ type: 'select-indicator', indicator: 'rsi' });
  assert.match(p.nodes.get('indicator-detail').textContent, /RSI6 —/);
  const detail = p.nodes.get('detail').textContent;
  p.receive({ type: 'data', data: { symbol: 'sz000001', mode: 'intraday', bars: [] } });
  assert.equal(p.nodes.get('detail').textContent, detail);
});
test('本地图表释放iframe，新个股以宿主传入模式为准', () => {
  const p = page({ mode: 'chips', saved: { mode: 'daily', range: 60 } });
  // HTML defaults and saved state cannot trigger a remote request before host confirmation.
  p.advance(1000); assert.equal(p.writes.length, 0);
  p.receive({ type: 'select-mode', mode: 'chips' }); p.advance(400);
  assert.match(p.nodes.get('eastmoney').src, /h5chart-iframe/);
  p.receive({ type: 'select-mode', mode: 'daily' }); assert.equal(p.nodes.get('web-chart').hidden, true);
  assert.equal(p.nodes.get('local').hidden, false); assert.equal(p.nodes.get('eastmoney').getAttribute('src'), null);
  assert.equal(p.messages.at(-1).mode, 'daily');
  p.receive({ type: 'select-mode', mode: 'chips' }); p.advance(400); assert.match(p.nodes.get('eastmoney').src, /h5chart-iframe/);
});
test('不支持筹码的品种使用内置分时，错误令牌不能加载网页', () => {
  const p = page({ chips: false }); p.receive({ type: 'select-mode', mode: 'chips' });
  assert.equal(p.messages.at(-1).mode, 'intraday');
  p.receive({ type: 'select-mode', mode: 'eastmoney', token: 'wrong' }); p.advance(400);
  assert.equal(p.nodes.get('local').hidden, false); assert.equal(p.writes.length, 0);
  const writes = p.writes.length;
  p.receive({ type: 'refresh', mode: 'eastmoney', token: 'wrong' }); assert.equal(p.writes.length, writes);
});

test('默认内置图表以及网页加载前切回内置图表，均不会发起第三方导航', () => {
  const p = page(); p.receive({ type: 'select-mode', mode: 'intraday' }); p.advance(1000);
  assert.equal(p.nodes.get('local').hidden, false); assert.equal(p.writes.length, 0);
  p.receive({ type: 'select-mode', mode: 'eastmoney' }); p.advance(200);
  p.receive({ type: 'select-mode', mode: 'daily' }); p.advance(1000);
  assert.equal(p.writes.length, 0); assert.equal(p.nodes.get('eastmoney').getAttribute('src'), null);
});

test('就绪前切换及连续网页切换只加载最终选中的一种', () => {
  const p = page({ mode: 'eastmoney' }); p.advance(1000); assert.equal(p.writes.length, 0);
  p.receive({ type: 'select-mode', mode: 'eastmoney' }); p.advance(200);
  p.receive({ type: 'select-mode', mode: 'chips' }); p.receive({ type: 'refresh', mode: 'chips' });
  p.advance(400); assert.equal(p.writes.length, 1); assert.match(p.writes[0], /h5chart-iframe/);
});

test('页面周期按钮向宿主发消息，确认后高亮；点击冒泡不会回到分时', () => {
  const p = page(); p.receive({ type: 'select-mode', mode: 'intraday' });
  p.buttons.weekly.click(); assert.equal(p.messages.at(-1).action, 'period'); assert.equal(p.messages.at(-1).mode, 'weekly');
  p.receive({ type: 'select-mode', mode: 'weekly' });
  assert.equal(p.buttons.weekly.getAttribute('aria-pressed'), 'true'); assert.equal(p.buttons.intraday.getAttribute('aria-pressed'), 'false');
  const before = p.messages.length; p.buttons.monthly.click(); p.buttons.intraday.click();
  assert.deepEqual(p.messages.slice(before).map(m => m.mode), ['monthly', 'intraday']);
  p.receive({ type: 'select-mode', mode: 'intraday' }); assert.equal(p.buttons.intraday.getAttribute('aria-pressed'), 'true');
  p.receive({ type: 'select-mode', mode: 'daily' }); assert.equal(p.buttons.daily.getAttribute('aria-pressed'), 'true');
  assert.equal(p.writes.length, 0);
});
