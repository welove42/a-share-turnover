'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function page({ mode = 'eastmoney', chips = true, saved = {} } = {}) {
  const nodes = new Map(), messages = [], receivers = [], writes = [];
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
    document, window: { addEventListener: (event, fn) => receivers.push(fn) },
    acquireVsCodeApi: () => ({ getState: () => saved, setState() {}, postMessage: message => messages.push(message) })
  });
  return { nodes, buttons, messages, writes, receive: message => receivers.forEach(fn => fn({ data: { token: 'test-token', ...message } })) };
}

test('点击图表按钮不会因冒泡到body而切回默认图表；重复点击不重载iframe', () => {
  const p = page(); p.buttons.chips.click();
  assert.equal(p.buttons.chips.getAttribute('aria-pressed'), 'true');
  assert.match(p.nodes.get('eastmoney').src, /h5chart-iframe/);
  assert.equal(p.messages.filter(m => m.action === 'mode').length, 1);
  assert.equal(p.messages.at(-1).mode, 'chips');
  const writes = p.writes.length; p.buttons.chips.click(); assert.equal(p.writes.length, writes);
  p.nodes.get('external').click(); assert.equal(p.messages.at(-1).action, 'external');
  p.nodes.get('refresh').click(); assert.equal(p.writes.length, writes + 1);
  p.buttons.eastmoney.click(); assert.match(p.nodes.get('eastmoney').src, /full\.html/);
});
test('本地图表释放iframe且不会冒泡回网页；新个股以宿主传入模式为准', () => {
  const p = page({ mode: 'chips', saved: { mode: 'daily', range: 60 } });
  assert.equal(p.buttons.chips.getAttribute('aria-pressed'), 'true');
  p.buttons.daily.click(); assert.equal(p.nodes.get('web-chart').hidden, true);
  assert.equal(p.nodes.get('local').hidden, false); assert.equal(p.nodes.get('eastmoney').getAttribute('src'), null);
  assert.equal(p.messages.at(-1).mode, 'daily');
  p.receive({ type: 'select-mode', mode: 'chips' }); assert.match(p.nodes.get('eastmoney').src, /h5chart-iframe/);
});
test('不支持筹码的品种使用常规页，错误令牌不能切换模式', () => {
  const p = page({ chips: false }); p.receive({ type: 'select-mode', mode: 'chips' });
  assert.equal(p.buttons.eastmoney.getAttribute('aria-pressed'), 'true');
  assert.match(p.nodes.get('hint').textContent, /仅对沪深A股个股开放/);
  p.receive({ type: 'select-mode', mode: 'daily', token: 'wrong' });
  assert.equal(p.buttons.eastmoney.getAttribute('aria-pressed'), 'true');
});
