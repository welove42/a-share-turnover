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
    value.getScreenCTM = () => ({ inverse: () => ({}) });
    nodes.set(id, value); return value;
  }
  body = node('body', { symbol: 'sh600105', token: 'test-token', mode,
    regularUrl: 'https://quote.eastmoney.com/basic/full.html?mcid=1.600105',
    chipsUrl: chips ? 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=600105&market=1' : '' });
  const buttons = Object.fromEntries(['intraday', 'm1', 'm5', 'm15', 'm30', 'm60', 'daily', 'weekly', 'monthly'].map(period => [period, node(period, { period })]));
  const indicatorButtons = Object.fromEntries(['macd', 'kdj', 'rsi', 'none'].map(indicator => [indicator, node('button-' + indicator, { indicator })]));
  const document = { body, getElementById: id => nodes.get(id) || node(id),
    createElementNS: (_, tag) => node(tag), createDocumentFragment: () => node('fragment'),
    querySelectorAll: selector => selector === 'button[data-period]' ? Object.values(buttons) : selector === 'button[data-indicator]' ? Object.values(indicatorButtons) : [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/chart.js'), 'utf8'), {
    document, marketIndicators: require('../media/indicators'), DOMPoint: class { constructor(x, y) { this.x = x; this.y = y; } matrixTransform() { return this; } }, window: { addEventListener: (event, fn) => { if (event === 'message') receivers.push(fn); } },
    Date: { now: () => now }, setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: id => timers.delete(id),
    acquireVsCodeApi: () => ({ getState: () => saved, setState() {}, postMessage: message => messages.push(message) })
  });
  return { nodes, buttons, indicatorButtons, messages, writes, advance, receive: message => receivers.forEach(fn => fn({ data: { token: 'test-token', ...message } })) };
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
const rendered = p => [...descendants(p.nodes.get('svg')), ...descendants(p.nodes.get('indicator-svg'))];

test('页面副图按钮等待宿主确认再高亮，读图说明在无行情时也可用', () => {
  const p = page();
  assert.equal(p.indicatorButtons.macd.getAttribute('aria-pressed'), 'true');
  assert.match(p.nodes.get('indicator-guide-title').textContent, /MACD.*12,26,9/);
  assert.match(p.nodes.get('indicator-guide-body').textContent, /2×.*金叉.*零轴/);
  p.indicatorButtons.kdj.click();
  assert.equal(p.messages.at(-1).action, 'indicator'); assert.equal(p.messages.at(-1).indicator, 'kdj');
  assert.equal(p.messages.at(-1).token, 'test-token');
  assert.equal(p.indicatorButtons.macd.getAttribute('aria-pressed'), 'true');
  p.receive({ type: 'select-indicator', indicator: 'kdj' });
  assert.equal(p.indicatorButtons.kdj.getAttribute('aria-pressed'), 'true');
  assert.equal(p.indicatorButtons.macd.getAttribute('aria-pressed'), 'false');
  assert.match(p.nodes.get('indicator-guide-body').textContent, /80.*20.*钝化/);
  const count = p.messages.length; p.indicatorButtons.kdj.click(); assert.equal(p.messages.length, count);
  for (const message of [{ indicator: 'invalid' }, { indicator: 'rsi', token: 'old-token' }]) p.receive({ type: 'select-indicator', ...message });
  assert.equal(p.indicatorButtons.kdj.getAttribute('aria-pressed'), 'true');
});

test('副图读法随指标和周期同步，隐藏副图仍保留说明，网页模式不切换', () => {
  const p = page(); p.receive({ type: 'select-indicator', indicator: 'rsi' });
  assert.match(p.nodes.get('indicator-guide-body').textContent, /0–100.*RSI6.*RSI24.*20\/80/);
  assert.match(p.nodes.get('indicator-guide-context').textContent, /当日分钟采样.*每日重置/);
  for (const [mode, name] of [['m5', '5分钟K'], ['daily', '日K'], ['weekly', '周K'], ['monthly', '月K']]) {
    p.receive({ type: 'select-mode', mode });
    assert.ok(p.nodes.get('indicator-guide-context').textContent.includes(name));
    assert.match(p.nodes.get('indicator-guide-context').textContent, /K线根数.*未收盘/);
    assert.equal(p.indicatorButtons.rsi.getAttribute('aria-pressed'), 'true');
  }
  p.receive({ type: 'select-indicator', indicator: 'none' });
  assert.equal(p.nodes.get('indicator-guide-context').textContent, '');
  assert.match(p.nodes.get('indicator-guide-body').textContent, /恢复副图.*悬停/);
  p.receive({ type: 'select-mode', mode: 'eastmoney' }); const count = p.messages.length;
  p.indicatorButtons.macd.click(); assert.equal(p.messages.length, count);
});

test('键盘从图表移到副图按钮并切换，保留日期定位和均线数值', () => {
  const p = page(); p.receive({ type: 'select-mode', mode: 'daily' });
  p.receive({ type: 'data', data: { symbol: 'sh600105', name: '测试股', source: '测试', mode: 'daily', date: '2026-10-28', bars: sampleBars } });
  p.nodes.get('plot').dispatch('keydown', { key: 'ArrowLeft' });
  const detail = p.nodes.get('detail').textContent, averages = p.nodes.get('average-detail').textContent;
  p.nodes.get('plot').dispatch('blur', { relatedTarget: p.indicatorButtons.rsi });
  p.indicatorButtons.rsi.click(); p.receive({ type: 'select-indicator', indicator: 'rsi' });
  assert.equal(p.nodes.get('detail').textContent, detail); assert.equal(p.nodes.get('average-detail').textContent, averages);
  assert.equal(p.nodes.get('chart-tooltip').hidden, false); assert.match(p.nodes.get('indicator-detail').textContent, /RSI/);
  p.nodes.get('plot').dispatch('blur'); assert.equal(p.nodes.get('chart-tooltip').hidden, true);
});

test('独立副图与主图同步定位，按钮和说明不改变日期，隐藏后仍能恢复', () => {
  const p = page(); p.receive({ type: 'select-mode', mode: 'daily' });
  p.receive({ type: 'data', data: { symbol: 'sh600105', name: '测试股', source: '测试', mode: 'daily', date: '2026-10-28', bars: sampleBars } });
  const plot = p.nodes.get('plot'), main = p.nodes.get('svg'), sub = p.nodes.get('indicator-svg');
  p.nodes.get('indicator-chart').offsetTop = 400;
  plot.dispatch('pointermove', { target: sub, clientX: 68, clientY: 450 });
  const selected = p.nodes.get('detail').textContent;
  assert.ok(selected.includes(sampleBars[60].time)); assert.equal(p.nodes.get('chart-tooltip').style.top, '432px');
  const cross = svg => descendants(svg).find(n => n.getAttribute('class') === 'crosshair');
  assert.equal(cross(main).getAttribute('x1'), cross(sub).getAttribute('x1'));
  assert.equal(cross(sub).getAttribute('visibility'), 'visible');
  plot.dispatch('pointermove', { target: p.indicatorButtons.rsi, clientX: 967 });
  plot.dispatch('pointermove', { target: p.nodes.get('indicator-guide-body'), clientX: 967 });
  plot.dispatch('keydown', { target: p.indicatorButtons.rsi, key: 'ArrowRight' });
  assert.equal(p.nodes.get('detail').textContent, selected);
  const mainGeometry = main.getAttribute('viewBox');
  p.receive({ type: 'select-indicator', indicator: 'none' });
  assert.equal(p.nodes.get('indicator-chart').hidden, true); assert.equal(main.getAttribute('viewBox'), mainGeometry);
  assert.equal(p.nodes.get('chart-tooltip').style.top, '38px');
  p.indicatorButtons.kdj.click(); assert.equal(p.messages.at(-1).indicator, 'kdj');
  p.receive({ type: 'select-indicator', indicator: 'kdj' });
  assert.equal(p.nodes.get('indicator-chart').hidden, false); assert.equal(p.nodes.get('detail').textContent, selected);
  assert.ok(descendants(sub).some(n => n.getAttribute('class') === 'indicator-line'));
  p.receive({ type: 'select-mode', mode: 'monthly' });
  assert.equal(main.children.length, 0); assert.equal(sub.children.length, 0);
});

test('日周月均绘制K线与默认MACD，切换指标无需网络，跨周期保留选择', () => {
  const p = page();
  for (const mode of ['daily', 'weekly', 'monthly']) {
    p.receive({ type: 'select-mode', mode });
    p.receive({ type: 'data', data: { symbol: 'sh600105', name: '测试股', source: '测试', mode, date: '2026-10-28', adjustment: '前复权', bars: sampleBars } });
    assert.equal(p.nodes.get('range-label').hidden, false);
    assert.match(p.nodes.get('meta').textContent, new RegExp({ daily: '日K', weekly: '周K', monthly: '月K' }[mode]));
    assert.ok(descendants(p.nodes.get('indicator-svg')).some(n => n.getAttribute('class') === 'indicator-bar'));
    assert.doesNotMatch(JSON.stringify(rendered(p).map(n => n.getAttribute('points'))), /NaN|Infinity/);
  }
  const messages = p.messages.length;
  p.receive({ type: 'select-indicator', indicator: 'rsi' });
  assert.match(p.nodes.get('indicator-detail').textContent, /RSI6.*RSI12.*RSI24/);
  const latest = p.nodes.get('indicator-detail').textContent;
  p.nodes.get('plot').dispatch('keydown', { key: 'ArrowLeft' });
  assert.notEqual(p.nodes.get('indicator-detail').textContent, latest);
  const selected = p.nodes.get('indicator-detail').textContent;
  p.nodes.get('range').value = '60'; p.nodes.get('range').dispatch('change');
  assert.equal(p.nodes.get('indicator-detail').textContent, selected);
  p.receive({ type: 'select-indicator', indicator: 'none' });
  assert.equal(p.nodes.get('indicator-detail').textContent, ''); assert.equal(p.nodes.get('indicator-chart').hidden, true);
  assert.equal(p.nodes.get('indicator-svg').children[0].children.length, 0);
  assert.equal(p.messages.length, messages); assert.equal(p.writes.length, 0);
});

test('日周月及所有分钟周期悬停同步MA、副图图例、详情卡，历史涨幅使用前一根K线', () => {
  const p = page(), plot = () => p.nodes.get('plot');
  for (const mode of ['daily', 'weekly', 'monthly', 'm1', 'm5', 'm15', 'm30', 'm60']) {
    const bars = sampleBars.map(b => ({ ...b }));
    const data = { symbol: 'sh600105', name: '测试股', mode, date: '2026-10-28', previousClose: 999, bars };
    p.receive({ type: 'select-mode', mode }); p.receive({ type: 'data', data });
    const before = p.nodes.get('average-detail').textContent;
    // With 180 visible bars, the first bar is absolute index 60.
    plot().dispatch('pointermove', { clientX: 68, clientY: 100 });
    const expected = bars.slice(56, 61).reduce((s, b) => s + b.close, 0) / 5;
    const series = name => rendered(p).find(n => n.getAttribute('data-series') === name).textContent;
    assert.equal(series('MA5'), `MA5 ${expected.toFixed(2)}`);
    assert.notEqual(p.nodes.get('average-detail').textContent, before);
    assert.match(p.nodes.get('chart-tooltip').textContent, new RegExp(bars[60].time));
    assert.match(p.nodes.get('chart-tooltip').textContent, /MA5.*MA10.*MA20[\s\S]*MA30.*MA60[\s\S]*VMA5.*VMA10[\s\S]*MACD[\s\S]*KDJ[\s\S]*RSI/);
    const change = (bars[60].close / bars[59].close - 1) * 100;
    assert.ok(p.nodes.get('detail').textContent.includes(`${change > 0 ? '+' : ''}${change.toFixed(2)}%`));
    assert.ok(p.nodes.get('indicator-detail').textContent.includes(series('DIF')));
    for (const indicator of ['rsi', 'kdj']) {
      p.receive({ type: 'select-indicator', indicator });
      assert.match(p.nodes.get('chart-tooltip').textContent, new RegExp(bars[60].time));
      assert.ok(p.nodes.get('indicator-detail').textContent.includes(series(indicator === 'rsi' ? 'RSI6' : 'K')));
    }
    p.receive({ type: 'select-indicator', indicator: 'macd' });
    // New history is appended; the selected date and its values must survive redraw.
    const selected = p.nodes.get('average-detail').textContent;
    p.receive({ type: 'data', data: { ...data, bars: [...bars, { ...bars.at(-1), time: '2026-12-31', close: 50, high: 51 }] } });
    assert.equal(p.nodes.get('average-detail').textContent, selected);
    assert.match(p.nodes.get('detail').textContent, new RegExp(bars[60].time));
    plot().dispatch('pointerleave');
    assert.equal(p.nodes.get('chart-tooltip').hidden, true);
    assert.match(p.nodes.get('detail').textContent, /2026-12-31/);
  }
});

test('分时绘制真实成交均价，鼠标定位及跨日刷新不串值；缺字段显示空值', () => {
  const p = page();
  const data = { symbol: 'sh600105', mode: 'intraday', name: '测试股', source: '测试', date: '2026-10-28', previousClose: 10,
    bars: ['0930', '0931', '0932'].map((time, i) => ({ time, open: 10 + i, close: 10 + i, high: 10 + i, low: 10 + i,
      volume: 100, cumulativeVolume: 100 * (i + 1), amount: 100000 + i * 10000, cumulativeAmount: (i + 1) * (100000 + i * 5000), averagePrice: 10 + i * .5 })) };
  p.receive({ type: 'data', data });
  assert.ok(descendants(p.nodes.get('svg')).some(n => n.getAttribute('class') === 'intraday-average'));
  p.nodes.get('plot').dispatch('pointermove', { clientX: 68, clientY: 100 });
  assert.match(p.nodes.get('chart-tooltip').textContent, /09:30[\s\S]*均价 10.00[\s\S]*累计额 10.00万元/);
  p.receive({ type: 'data', data });
  assert.match(p.nodes.get('detail').textContent, /09:30/);
  p.receive({ type: 'data', data: { ...data, date: '2026-10-29' } });
  assert.equal(p.nodes.get('chart-tooltip').hidden, true);
  assert.match(p.nodes.get('detail').textContent, /2026-10-29 09:32/);
  p.receive({ type: 'data', data: { ...data, bars: [{ ...data.bars[0], averagePrice: null, amount: null, cumulativeAmount: null }] } });
  assert.match(p.nodes.get('average-detail').textContent, /均价 —/);
  assert.doesNotMatch(p.nodes.get('detail').textContent, /NaN|Infinity/);
  assert.ok(!descendants(p.nodes.get('svg')).some(n => n.getAttribute('class') === 'intraday-average'));
});

test('短分时KDJ提示数据不足、RSI无无效数值，旧股票消息不覆盖当前图', () => {
  const p = page(); p.receive({ type: 'select-mode', mode: 'intraday' });
  p.receive({ type: 'data', data: { symbol: 'sh600105', mode: 'intraday', name: '测试股', source: '测试', date: '2026-10-28', previousClose: 10, bars: [{ ...sampleBars[0], time: '0930' }] } });
  p.receive({ type: 'select-indicator', indicator: 'kdj' });
  assert.ok(descendants(p.nodes.get('indicator-svg')).some(n => /数据不足/.test(n.textContent)));
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
