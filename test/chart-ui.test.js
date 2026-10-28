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
    const value = { dataset, style: {}, classList: { add() {} }, hidden: false,
      setAttribute(key, data) { attrs.set(key, String(data)); }, getAttribute: key => attrs.get(key) ?? null,
      removeAttribute: key => attrs.delete(key), replaceChildren() {},
      addEventListener(key, fn) { if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); },
      click() { for (const fn of listeners.get('click') || []) fn({ target: value }); if (value !== body) body.click(); }
    };
    Object.defineProperty(value, 'src', { get: () => attrs.get('src'), set: url => { attrs.set('src', url); writes.push(url); } });
    nodes.set(id, value); return value;
  }
  body = node('body', { symbol: 'sh600105', token: 'test-token', mode,
    regularUrl: 'https://quote.eastmoney.com/basic/full.html?mcid=1.600105',
    chipsUrl: chips ? 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=600105&market=1' : '' });
  const buttons = Object.fromEntries(['eastmoney', 'chips', 'intraday', 'daily'].map(mode => [mode, node(mode, { mode })]));
  const document = { body, getElementById: id => nodes.get(id) || node(id),
    querySelectorAll: selector => selector === 'button[data-mode]' ? Object.values(buttons) : selector === '[data-mode]' ? [body, ...Object.values(buttons)] : [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/chart.js'), 'utf8'), {
    document, window: { addEventListener: (event, fn) => { if (event === 'message') receivers.push(fn); } },
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
