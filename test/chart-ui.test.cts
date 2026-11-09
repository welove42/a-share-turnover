'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');

function page({ mode = 'intraday', chips = true, saved = {}, symbol = 'sh600105' } = {}) {
  const nodes = new Map(),
    messages = [],
    receivers = [],
    writes = [],
    timers = new Map();
  let now = 0,
    nextTimer = 0;
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers])
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
  };
  let body;
  function node(id, dataset = {}) {
    const attrs = new Map(),
      listeners = new Map();
    let ownText = '';
    const value = {
      tag: id,
      children: [],
      dataset,
      style: {},
      classList: { add() {} },
      hidden: false,
      setAttribute(key, data) {
        attrs.set(key, String(data));
      },
      getAttribute: (key) => attrs.get(key) ?? null,
      removeAttribute: (key) => attrs.delete(key),
      replaceChildren(...items) {
        ownText = '';
        this.children = items;
      },
      append(...items) {
        this.children.push(...items);
      },
      dispatch(key, event = {}) {
        for (const fn of listeners.get(key) || []) fn({ target: value, preventDefault() {}, ...event });
      },
      addEventListener(key, fn) {
        if (!listeners.has(key)) listeners.set(key, []);
        listeners.get(key).push(fn);
      },
      click() {
        for (const fn of listeners.get('click') || []) fn({ target: value });
        if (value !== body) body.click();
      }
    };
    Object.defineProperty(value, 'textContent', {
      get: () => ownText + value.children.map((child) => child.textContent || '').join(''),
      set: (text) => {
        ownText = String(text);
        value.children = [];
      }
    });
    Object.defineProperty(value, 'src', {
      get: () => attrs.get('src'),
      set: (url) => {
        attrs.set('src', url);
        writes.push(url);
      }
    });
    value.getScreenCTM = () => ({ inverse: () => ({}) });
    nodes.set(id, value);
    return value;
  }
  body = node('body', {
    symbol,
    token: 'test-token',
    mode,
    regularUrl: 'https://quote.eastmoney.com/basic/full.html?mcid=1.600105',
    chipsUrl: chips ? 'https://quote.eastmoney.com/basic/h5chart-iframe.html?code=600105&market=1' : ''
  });
  const buttons = Object.fromEntries(
    ['intraday', 'intraday5', 'm1', 'm5', 'm15', 'm30', 'm60', 'daily', 'weekly', 'monthly'].map((period) => [
      period,
      node(period, { period })
    ])
  );
  const indicatorButtons = Object.fromEntries(
    ['macd', 'kdj', 'rsi', 'none'].map((indicator) => [indicator, node('button-' + indicator, { indicator })])
  );
  const document = {
    body,
    getElementById: (id) => nodes.get(id) || node(id),
    createElement: (tag) => node(tag),
    createElementNS: (_, tag) => node(tag),
    createDocumentFragment: () => node('fragment'),
    querySelectorAll: (selector) =>
      selector === 'button[data-period]'
        ? Object.values(buttons)
        : selector === 'button[data-indicator]'
          ? Object.values(indicatorButtons)
          : []
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/webviews/chart.js'), 'utf8'), {
    document,
    marketIndicators: require('../dist/shared/indicators.js'),
    DOMPoint: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
      matrixTransform() {
        return this;
      }
    },
    window: {
      addEventListener: (event, fn) => {
        if (event === 'message') receivers.push(fn);
      }
    },
    Date: { now: () => now },
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    acquireVsCodeApi: () => ({ getState: () => saved, setState() {}, postMessage: (message) => messages.push(message) })
  });
  return {
    nodes,
    buttons,
    indicatorButtons,
    messages,
    writes,
    advance,
    receive: (message) => receivers.forEach((fn) => fn({ data: { token: 'test-token', ...message } }))
  };
}

test('编辑器切换网页图表合并快速选择，重复选择不重载，连续刷新限频', () => {
  const p = page();
  p.receive({ type: 'select-mode', mode: 'chips' });
  assert.equal(p.writes.length, 0);
  p.advance(400);
  assert.match(p.nodes.get('eastmoney').src, /h5chart-iframe/);
  assert.equal(p.messages.filter((m) => m.action === 'mode-ready').length, 1);
  assert.equal(p.messages.at(-1).mode, 'chips');
  const writes = p.writes.length;
  p.receive({ type: 'select-mode', mode: 'chips' });
  assert.equal(p.writes.length, writes);
  p.receive({ type: 'refresh', mode: 'chips' });
  p.advance(400);
  assert.equal(p.writes.length, writes);
  p.advance(5000);
  p.receive({ type: 'refresh', mode: 'chips' });
  p.receive({ type: 'refresh', mode: 'chips' });
  p.advance(400);
  assert.equal(p.writes.length, writes + 1);
  p.receive({ type: 'refresh', mode: 'eastmoney' });
  assert.equal(p.writes.length, writes + 1);
  p.receive({ type: 'select-mode', mode: 'eastmoney' });
  p.advance(400);
  assert.match(p.nodes.get('eastmoney').src, /full\.html/);
});

const sampleBars = Array.from({ length: 240 }, (_, i) => ({
  time: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
  open: 10 + i * 0.01,
  close: 10 + i * 0.01 + Math.sin(i) * 0.2,
  high: 11 + i * 0.01,
  low: 9 + i * 0.01,
  volume: 100 + i
}));
const descendants = (item) => [item, ...item.children.flatMap(descendants)];
const rendered = (p) => [...descendants(p.nodes.get('svg')), ...descendants(p.nodes.get('indicator-svg'))];

test('ETF 顶部独立展示折溢价和 IOPV，历史悬停不改变最新参考数值', () => {
  const p = page({ mode: 'daily', symbol: 'sh510300' });
  p.receive({ type: 'select-mode', mode: 'daily' });
  p.advance(Date.parse('2026-11-09T10:30:30+08:00'));
  const etf = {
    symbol: 'sh510300',
    price: 4.145,
    iopv: 4.1404,
    premiumRate: 0.11,
    quoteTimestamp: '20261109103029',
    timestampMs: Date.parse('2026-11-09T10:30:29+08:00'),
    source: '腾讯行情',
    notice: ''
  };
  const d = {
    symbol: 'sh510300',
    mode: 'daily',
    name: '测试ETF',
    date: '2026-11-09',
    source: '腾讯行情',
    bars: sampleBars,
    etfEligible: true,
    etfStatus: 'ready',
    etf
  };
  p.receive({ type: 'data', data: d });
  const box = p.nodes.get('etf-reference');
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /\+0.11%（溢价）.*IOPV.*4.1404.*4.145/);
  assert.match(box.textContent, /行情时间 2026-11-09 10:30:29/);
  assert.match(box.textContent, /无独立更新时间/);
  const before = box.textContent;
  p.nodes.get('plot').dispatch('pointermove', { clientX: 77, clientY: 100 });
  assert.equal(box.textContent, before);
  assert.doesNotMatch(p.nodes.get('chart-tooltip').textContent, /IOPV|溢价/);
  assert.ok(descendants(box).some((n) => n.className === 'detail-value rising'));
  p.receive({ type: 'data', data: { ...d, etf: { ...etf, premiumRate: -0.11 } } });
  assert.match(box.textContent, /-0.11%（折价）/);
  assert.ok(descendants(box).some((n) => n.className === 'detail-value falling'));
  p.receive({ type: 'select-mode', mode: 'intraday' });
  assert.equal(box.hidden, true);
});

test('ETF 参考时间过旧、未来、缺失和请求失败有清楚提示，非 ETF 不占位', () => {
  const p = page({ mode: 'daily', symbol: 'sh510300' }),
    now = Date.parse('2026-11-09T10:30:30+08:00');
  p.advance(now);
  p.receive({ type: 'select-mode', mode: 'daily' });
  const etf = {
    symbol: 'sh510300',
    price: 4.145,
    iopv: 4.1404,
    premiumRate: 0.11,
    quoteTimestamp: '20261106093000',
    timestampMs: now - 86400000,
    source: '腾讯行情',
    notice: ''
  };
  const d = {
    symbol: 'sh510300',
    mode: 'daily',
    date: '2026-11-09',
    bars: sampleBars,
    etfEligible: true,
    etfStatus: 'ready',
    etf
  };
  const box = p.nodes.get('etf-reference');
  p.receive({ type: 'data', data: d });
  assert.match(box.textContent, /较早行情/);
  p.receive({ type: 'error', mode: 'daily', preserve: true, message: '请求失败' });
  assert.match(box.textContent, /更新失败，保留上次数据/);
  p.receive({ type: 'data', data: { ...d, etf: { ...etf, timestampMs: now + 120000 } } });
  assert.match(box.textContent, /行情时间异常/);
  assert.doesNotMatch(box.textContent, /4.1404|0.11%/);
  p.receive({ type: 'data', data: { ...d, etf: { ...etf, iopv: null, premiumRate: null, notice: '暂无有效 IOPV' } } });
  assert.match(box.textContent, /折溢价率 —.*IOPV.*—/);
  p.receive({ type: 'data', data: { ...d, etf: undefined, etfStatus: 'loading' } });
  assert.match(box.textContent, /正在获取 ETF/);
  p.receive({ type: 'data', data: { ...d, etf: undefined, etfStatus: 'error' } });
  assert.match(box.textContent, /获取失败/);
  p.receive({ type: 'data', data: { ...d, etf: undefined, etfStatus: 'unavailable' } });
  assert.equal(box.hidden, true);
  p.receive({ type: 'data', data: { ...d, etfEligible: false } });
  assert.equal(box.hidden, true);
});
test('K线放大缩小按钮与 Ctrl 滚轮调整显示范围，普通滚轮不拦截', () => {
  const p = page({ mode: 'daily', saved: { range: 60 } });
  p.receive({ type: 'select-mode', mode: 'daily' });
  p.receive({
    type: 'data',
    data: {
      symbol: 'sh600105',
      name: '测试股',
      mode: 'daily',
      source: '测试',
      date: '2026-10-28',
      adjustment: '前复权',
      bars: sampleBars
    }
  });
  const count = () => descendants(p.nodes.get('svg')).filter((n) => n.getAttribute('class') === 'volume-bar').length;
  const plot = p.nodes.get('plot');
  let prevented = 0;
  assert.equal(count(), 60);
  p.nodes.get('zoom-in').click();
  assert.equal(count(), 30);
  assert.equal(p.nodes.get('zoom-in').disabled, true);
  plot.dispatch('wheel', { ctrlKey: false, deltaY: 1, preventDefault: () => prevented++ });
  assert.equal(prevented, 0);
  assert.equal(count(), 30);
  plot.dispatch('wheel', { ctrlKey: true, deltaY: 1, preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.equal(count(), 60);
  p.nodes.get('zoom-out').click();
  assert.equal(count(), 90);
  for (let i = 0; i < 8; i++) p.nodes.get('zoom-out').click();
  assert.equal(count(), 240);
  assert.equal(p.nodes.get('zoom-out').disabled, true);
  p.receive({ type: 'select-mode', mode: 'intraday' });
  assert.equal(p.nodes.get('zoom-tools').hidden, true);
});

test('顶部展示所选K线的历史换手率，独立显示最新报价换手率', () => {
  const p = page({ mode: 'daily' });
  p.receive({ type: 'select-mode', mode: 'daily' });
  const d = {
    symbol: 'sh600105',
    name: '测试股',
    mode: 'daily',
    source: '腾讯行情',
    date: '2026-09-17',
    adjustment: '前复权',
    bars: sampleBars,
    turnoverApplicable: true,
    turnoverRate: 2.35,
    turnoverTimestamp: '20261102100530'
  };
  d.bars = sampleBars.map((bar, i) => ({ ...bar, historicalTurnover: i === 61 ? 4.56 : null }));
  p.receive({ type: 'data', data: d });
  assert.match(p.nodes.get('turnover').textContent, /最新换手率 2\.35%.*2026-11-02 10:05:30/);
  p.nodes.get('plot').dispatch('pointermove', { clientX: 77, clientY: 100 });
  assert.match(p.nodes.get('detail').textContent, /换手率 4\.56%/);
  assert.match(p.nodes.get('chart-tooltip').textContent, /换手率 4\.56%/);
  p.nodes.get('plot').dispatch('pointermove', { clientX: 82, clientY: 100 });
  assert.match(p.nodes.get('detail').textContent, /换手率 —/);
  p.receive({ type: 'data', data: { ...d, turnoverRate: null, turnoverTimestamp: null } });
  assert.equal(p.nodes.get('turnover').textContent, '最新换手率 —');
  p.receive({ type: 'data', data: { ...d, turnoverApplicable: false, turnoverRate: null } });
  assert.equal(p.nodes.get('turnover').textContent, '');
});
test('分时高低与K线放在相同数据组，颜色按前收比较，历史日期不混入当日报价', () => {
  const p = page(),
    bars = [{ time: '0930', open: 10, close: 10, high: 10, low: 10, volume: 100, averagePrice: 10 }];
  const d = {
    symbol: 'sh600105',
    name: '测试股',
    mode: 'intraday',
    source: '腾讯行情',
    date: '2026-11-02',
    previousClose: 10,
    bars,
    dailyHigh: 12,
    dailyLow: 8,
    dailyQuoteTimestamp: '20261102113234'
  };
  const column = () =>
    descendants(p.nodes.get('detail')).find(
      (n) => n.className === 'detail-column' && n.children[0].children[0].textContent.trim() === '高'
    );
  p.receive({ type: 'data', data: d });
  let group = column();
  assert.equal(group.children[0].children[1].textContent, '12.00');
  assert.equal(group.children[0].children[1].className, 'detail-value rising');
  assert.equal(group.children[1].children[1].textContent, '8.00');
  assert.equal(group.children[1].children[1].className, 'detail-value falling');
  p.receive({ type: 'data', data: { ...d, dailyQuoteTimestamp: '20261030150000' } });
  group = column();
  assert.equal(group.children[0].children[1].textContent, '—');
  assert.equal(group.children[1].children[1].textContent, '—');
  p.receive({ type: 'select-mode', mode: 'daily' });
  p.receive({
    type: 'data',
    data: { ...d, mode: 'daily', date: '2026-09-17', adjustment: '前复权', bars: sampleBars }
  });
  p.nodes.get('plot').dispatch('pointermove', { clientX: 77, clientY: 100 });
  group = column();
  assert.equal(group.children[0].children[1].textContent, '11.61');
  assert.equal(group.children[1].children[1].textContent, '9.61');
  assert.match(p.nodes.get('chart-tooltip').textContent, /高 11\.61.*低 9\.61/);
});

test('历史换手率显示获取中、失败原因和缓存来源', () => {
  const p = page({ mode: 'daily' });
  p.receive({ type: 'select-mode', mode: 'daily' });
  const d = {
    symbol: 'sh600105',
    name: '测试股',
    mode: 'daily',
    source: '腾讯行情',
    date: '2026-09-17',
    adjustment: '前复权',
    bars: sampleBars,
    turnoverApplicable: true,
    historicalStatus: 'loading'
  };
  p.receive({ type: 'data', data: d });
  p.nodes.get('plot').dispatch('pointermove', { clientX: 77, clientY: 100 });
  assert.match(p.nodes.get('history-status').textContent, /获取中/);
  assert.match(p.nodes.get('chart-tooltip').textContent, /获取中/);
  p.receive({
    type: 'data',
    data: { ...d, historicalStatus: 'error', historicalError: '历史换手率获取失败（东方财富：socket hang up）' }
  });
  assert.match(p.nodes.get('history-status').textContent, /socket hang up.*刷新重试/);
  assert.match(p.nodes.get('chart-tooltip').textContent, /获取失败/);
  p.receive({
    type: 'data',
    data: { ...d, historicalStatus: 'stale', historicalSource: '搜狐财经', historicalFetchedAt: '2026/11/2 10:00:00' }
  });
  assert.match(p.nodes.get('history-status').textContent, /搜狐财经.*缓存.*10:00:00/);
});

test('五日分时区分历史全天换手率和最后一天的最新值', () => {
  const p = page({ mode: 'intraday5' });
  p.receive({ type: 'select-mode', mode: 'intraday5' });
  const bars = [
    {
      time: '2026-10-29 09:30',
      date: '2026-10-29',
      dayIndex: 0,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 1,
      historicalTurnover: 4.2
    },
    {
      time: '2026-10-30 09:30',
      date: '2026-10-30',
      dayIndex: 1,
      open: 11,
      high: 11,
      low: 11,
      close: 11,
      volume: 1,
      historicalTurnover: 1.3
    }
  ];
  p.receive({
    type: 'data',
    data: {
      symbol: 'sh600105',
      mode: 'intraday5',
      name: '测试股',
      source: '腾讯行情',
      date: '2026-10-30',
      dates: ['2026-10-29', '2026-10-30'],
      bars,
      turnoverApplicable: true
    }
  });
  assert.match(p.nodes.get('detail').textContent, /当日换手率（最新） 1\.30%/);
  p.nodes.get('plot').dispatch('pointermove', { clientX: 77, clientY: 100 });
  assert.match(p.nodes.get('detail').textContent, /当日换手率（全天） 4\.20%/);
});

test('明细按两行分组，价格相对前收着色，缺少前收时不着色', () => {
  const p = page({ mode: 'daily' });
  p.receive({ type: 'select-mode', mode: 'daily' });
  const bars = [
    { time: '2026-10-29', open: 10, close: 10, high: 11, low: 9, volume: 100 },
    { time: '2026-10-30', open: 11, close: 9, high: 12, low: 8, volume: 120, historicalTurnover: 2.5 }
  ];
  p.receive({
    type: 'data',
    data: {
      symbol: 'sh600105',
      mode: 'daily',
      name: '测试股',
      source: '腾讯行情',
      date: '2026-10-30',
      adjustment: '前复权',
      bars,
      turnoverApplicable: true
    }
  });
  const nodes = descendants(p.nodes.get('detail'));
  const value = (label) =>
    nodes.find((n) => n.className === 'detail-row' && n.children[0].textContent.trim() === label).children[1];
  assert.equal(value('开').className, 'detail-value rising');
  assert.equal(value('收').className, 'detail-value falling');
  assert.equal(value('涨跌幅').textContent, '-10.00%');
  assert.equal(value('换手率').textContent, '2.50%');
  p.nodes.get('plot').dispatch('pointermove', { clientX: 77, clientY: 100 });
  const missing = descendants(p.nodes.get('detail')).find(
    (n) => n.className === 'detail-row' && n.children[0].textContent.trim() === '涨跌幅'
  ).children[1];
  assert.equal(missing.textContent, '—');
  assert.equal(missing.className, 'detail-value');
});
test('科创板分时价格波动按正确均价拉伸，零股成交量以小数手展示', () => {
  const p = page();
  const bars = [
    {
      time: '0930',
      open: 639,
      close: 639,
      high: 639,
      low: 639,
      volume: 100.01,
      cumulativeVolume: 100.01,
      averagePrice: 639
    },
    {
      time: '0931',
      open: 565,
      close: 565,
      high: 565,
      low: 565,
      volume: 110.05,
      cumulativeVolume: 210.06,
      averagePrice: 600
    },
    {
      time: '0932',
      open: 658,
      close: 658,
      high: 658,
      low: 658,
      volume: 220.03,
      cumulativeVolume: 430.09,
      averagePrice: 599
    }
  ];
  p.receive({
    type: 'data',
    data: {
      symbol: 'sh600105',
      mode: 'intraday',
      name: '测试股',
      date: '2026-11-02',
      source: '腾讯行情',
      previousClose: 647.05,
      bars
    }
  });
  const line = descendants(p.nodes.get('svg')).find(
    (n) => n.tag === 'polyline' && n.getAttribute('stroke') === 'var(--chart-series-2, #5bbcff)'
  );
  const ys = line
    .getAttribute('points')
    .split(' ')
    .map((point) => Number(point.split(',')[1]));
  assert.ok(Math.max(...ys) - Math.min(...ys) > 100);
  assert.match(p.nodes.get('detail').textContent, /分钟成交量 220\.03手/);
  assert.match(p.nodes.get('detail').textContent, /均价 599\.00/);
});

test('分时在匹配行情日期显示真实日高日低水平线并纳入纵轴，不虚构发生时间', () => {
  const p = page(),
    bars = [
      { time: '0930', open: 10, close: 10, high: 10, low: 10, volume: 100 },
      { time: '0931', open: 11, close: 11, high: 11, low: 11, volume: 100 }
    ];
  const data = {
    symbol: 'sh600105',
    mode: 'intraday',
    name: '测试股',
    date: '2026-11-02',
    source: '腾讯行情',
    previousClose: 10,
    bars,
    dailyHigh: 12,
    dailyLow: 8,
    dailyQuoteTimestamp: '20261102113234'
  };
  p.receive({ type: 'data', data });
  const labels = () => descendants(p.nodes.get('svg')).filter((n) => n.getAttribute('class') === 'daily-extreme-label');
  const lines = () => descendants(p.nodes.get('svg')).filter((n) => n.getAttribute('class') === 'daily-extreme-line');
  assert.deepEqual(
    labels().map((n) => n.textContent),
    ['日最高 12.00', '日最低 8.00']
  );
  assert.equal(lines().length, 2);
  for (const line of lines()) {
    assert.equal(line.getAttribute('x1'), '68');
    assert.equal(line.getAttribute('x2'), '967');
    assert.ok(Number(line.getAttribute('y1')) >= 40 && Number(line.getAttribute('y1')) <= 295);
  }
  p.receive({ type: 'data', data: { ...data, dailyQuoteTimestamp: '20261030150000' } });
  assert.equal(labels().length, 0);
  p.receive({ type: 'data', data: { ...data, dailyHigh: null } });
  assert.deepEqual(
    labels().map((n) => n.textContent),
    ['日最低 8.00']
  );
  p.receive({ type: 'data', data: { ...data, dailyHigh: 10, dailyLow: 10 } });
  assert.deepEqual(
    labels().map((n) => n.textContent),
    ['日高/日低 10.00']
  );
  p.receive({ type: 'data', data: { ...data, dailyHigh: 8, dailyLow: 12 } });
  assert.equal(labels().length, 0);
});
test('五日分时的日高日低只覆盖最后一个匹配的交易日', () => {
  const p = page({ mode: 'intraday5' });
  p.receive({ type: 'select-mode', mode: 'intraday5' });
  const bars = ['2026-10-30', '2026-11-02'].map((date, dayIndex) => ({
    date,
    dayIndex,
    time: `${date} 09:30`,
    open: 10,
    close: 10,
    high: 10,
    low: 10,
    volume: 100
  }));
  const data = {
    symbol: 'sh600105',
    mode: 'intraday5',
    name: '测试股',
    date: '2026-11-02',
    dates: ['2026-10-30', '2026-11-02'],
    source: '腾讯行情',
    bars,
    dailyHigh: 12,
    dailyLow: 8,
    dailyQuoteTimestamp: '20261102113234'
  };
  p.receive({ type: 'data', data });
  let lines = descendants(p.nodes.get('svg')).filter((n) => n.getAttribute('class') === 'daily-extreme-line');
  assert.equal(lines.length, 2);
  assert.equal(Number(lines[0].getAttribute('x1')), 517.5);
  assert.equal(lines[0].getAttribute('x2'), '967');
  assert.match(p.nodes.get('detail').textContent, /高 12\.00低 8\.00/);
  p.nodes.get('plot').dispatch('pointermove', { clientX: 77, clientY: 100 });
  assert.match(p.nodes.get('detail').textContent, /高 —低 —/);
  p.receive({ type: 'data', data: { ...data, dailyQuoteTimestamp: '20261030150000' } });
  lines = descendants(p.nodes.get('svg')).filter((n) => n.getAttribute('class') === 'daily-extreme-line');
  assert.equal(lines.length, 0);
});

test('成交量区域高度随窗口缩放保持清晰，柱高线性且分时按相邻价格着色', () => {
  for (const width of [800, 1400]) {
    const p = page();
    const bars = [102, 99, 100, 100].map((close, i) => ({
      time: `093${i}`,
      open: close,
      close,
      high: close,
      low: close,
      volume: [100, 50, 25, 0][i],
      cumulativeVolume: 100,
      averagePrice: 100
    }));
    const data = {
      symbol: 'sh600105',
      mode: 'intraday',
      name: '测试股',
      date: '2026-11-02',
      source: '腾讯行情',
      previousClose: 101,
      bars
    };
    p.receive({ type: 'data', data });
    const svg = p.nodes.get('svg');
    svg.clientWidth = width;
    svg.clientHeight = 420;
    p.receive({ type: 'data', data });
    const all = descendants(svg),
      columns = all.filter((n) => n.getAttribute('class') === 'volume-bar');
    assert.equal(columns.length, 4);
    const heights = columns.map((n) => Number(n.getAttribute('height')));
    assert.ok((heights[0] * width) / 1040 >= 80);
    assert.ok(Math.abs(heights[1] / heights[0] - 0.5) < 1e-10);
    assert.ok(Math.abs(heights[2] / heights[0] - 0.25) < 1e-10);
    assert.equal(heights[3], 0);
    assert.deepEqual(
      columns.map((n) => n.getAttribute('fill')),
      [
        'var(--chart-up, #f05b68)',
        'var(--chart-down, #26bd8c)',
        'var(--chart-up, #f05b68)',
        'var(--vscode-descriptionForeground)'
      ]
    );
    assert.equal(all.filter((n) => n.getAttribute('class') === 'volume-tick').length, 4);
    assert.equal(all.filter((n) => n.getAttribute('class') === 'volume-grid-guide').length, 0); // Guides also carry their base class.
    assert.equal(all.filter((n) => n.getAttribute('class') === 'volume-grid volume-grid-guide').length, 3);
  }
});
test('五日分时的成交量颜色不跨交易日比较', () => {
  const p = page({ mode: 'intraday5' });
  p.receive({ type: 'select-mode', mode: 'intraday5' });
  const bars = [
    { time: '2026-10-29 09:30', date: '2026-10-29', dayIndex: 0, close: 10, previousClose: null },
    { time: '2026-10-30 09:30', date: '2026-10-30', dayIndex: 1, close: 11, previousClose: null },
    { time: '2026-10-30 09:31', date: '2026-10-30', dayIndex: 1, close: 12, previousClose: null }
  ].map((b) => ({ ...b, open: b.close, high: b.close, low: b.close, volume: 100 }));
  p.receive({
    type: 'data',
    data: {
      symbol: 'sh600105',
      mode: 'intraday5',
      name: '测试股',
      date: '2026-10-30',
      dates: ['2026-10-29', '2026-10-30'],
      source: '腾讯行情',
      bars
    }
  });
  const columns = descendants(p.nodes.get('svg')).filter((n) => n.getAttribute('class') === 'volume-bar');
  assert.equal(columns[1].getAttribute('fill'), 'var(--vscode-descriptionForeground)');
  assert.equal(columns[2].getAttribute('fill'), 'var(--chart-up, #f05b68)');
});

test('页面副图按钮等待宿主确认再高亮，读图说明在无行情时也可用', () => {
  const p = page();
  assert.equal(p.indicatorButtons.macd.getAttribute('aria-pressed'), 'true');
  assert.match(p.nodes.get('indicator-guide-title').textContent, /MACD.*12,26,9/);
  assert.match(p.nodes.get('indicator-guide-body').textContent, /2×.*金叉.*零轴/);
  p.indicatorButtons.kdj.click();
  assert.equal(p.messages.at(-1).action, 'indicator');
  assert.equal(p.messages.at(-1).indicator, 'kdj');
  assert.equal(p.messages.at(-1).token, 'test-token');
  assert.equal(p.indicatorButtons.macd.getAttribute('aria-pressed'), 'true');
  p.receive({ type: 'select-indicator', indicator: 'kdj' });
  assert.equal(p.indicatorButtons.kdj.getAttribute('aria-pressed'), 'true');
  assert.equal(p.indicatorButtons.macd.getAttribute('aria-pressed'), 'false');
  assert.match(p.nodes.get('indicator-guide-body').textContent, /80.*20.*钝化/);
  const count = p.messages.length;
  p.indicatorButtons.kdj.click();
  assert.equal(p.messages.length, count);
  for (const message of [{ indicator: 'invalid' }, { indicator: 'rsi', token: 'old-token' }])
    p.receive({ type: 'select-indicator', ...message });
  assert.equal(p.indicatorButtons.kdj.getAttribute('aria-pressed'), 'true');
});

test('副图读法随指标和周期同步，隐藏副图仍保留说明，网页模式不切换', () => {
  const p = page();
  p.receive({ type: 'select-indicator', indicator: 'rsi' });
  assert.match(p.nodes.get('indicator-guide-body').textContent, /0–100.*RSI6.*RSI24.*20\/80/);
  assert.match(p.nodes.get('indicator-guide-context').textContent, /当日分钟采样.*每日重置/);
  for (const [mode, name] of [
    ['m5', '5分钟K'],
    ['daily', '日K'],
    ['weekly', '周K'],
    ['monthly', '月K']
  ]) {
    p.receive({ type: 'select-mode', mode });
    assert.ok(p.nodes.get('indicator-guide-context').textContent.includes(name));
    assert.match(p.nodes.get('indicator-guide-context').textContent, /K线根数.*未收盘/);
    assert.equal(p.indicatorButtons.rsi.getAttribute('aria-pressed'), 'true');
  }
  p.receive({ type: 'select-indicator', indicator: 'none' });
  assert.equal(p.nodes.get('indicator-guide-context').textContent, '');
  assert.match(p.nodes.get('indicator-guide-body').textContent, /恢复副图.*悬停/);
  p.receive({ type: 'select-mode', mode: 'eastmoney' });
  const count = p.messages.length;
  p.indicatorButtons.macd.click();
  assert.equal(p.messages.length, count);
});

test('键盘从图表移到副图按钮并切换，保留日期定位和均线数值', () => {
  const p = page();
  p.receive({ type: 'select-mode', mode: 'daily' });
  p.receive({
    type: 'data',
    data: { symbol: 'sh600105', name: '测试股', source: '测试', mode: 'daily', date: '2026-10-28', bars: sampleBars }
  });
  p.nodes.get('plot').dispatch('keydown', { key: 'ArrowLeft' });
  const detail = p.nodes.get('detail').textContent,
    averages = p.nodes.get('average-detail').textContent;
  p.nodes.get('plot').dispatch('blur', { relatedTarget: p.indicatorButtons.rsi });
  p.indicatorButtons.rsi.click();
  p.receive({ type: 'select-indicator', indicator: 'rsi' });
  assert.equal(p.nodes.get('detail').textContent, detail);
  assert.equal(p.nodes.get('average-detail').textContent, averages);
  assert.equal(p.nodes.get('chart-tooltip').hidden, false);
  assert.match(p.nodes.get('indicator-detail').textContent, /RSI/);
  p.nodes.get('plot').dispatch('blur');
  assert.equal(p.nodes.get('chart-tooltip').hidden, true);
});

test('独立副图与主图同步定位，按钮和说明不改变日期，隐藏后仍能恢复', () => {
  const p = page();
  p.receive({ type: 'select-mode', mode: 'daily' });
  p.receive({
    type: 'data',
    data: { symbol: 'sh600105', name: '测试股', source: '测试', mode: 'daily', date: '2026-10-28', bars: sampleBars }
  });
  const plot = p.nodes.get('plot'),
    main = p.nodes.get('svg'),
    sub = p.nodes.get('indicator-svg');
  p.nodes.get('indicator-chart').offsetTop = 400;
  plot.dispatch('pointermove', { target: sub, clientX: 68, clientY: 450 });
  const selected = p.nodes.get('detail').textContent;
  assert.ok(selected.includes(sampleBars[60].time));
  assert.equal(p.nodes.get('chart-tooltip').style.top, '432px');
  const cross = (svg) => descendants(svg).find((n) => n.getAttribute('class') === 'crosshair');
  assert.equal(cross(main).getAttribute('x1'), cross(sub).getAttribute('x1'));
  assert.equal(cross(sub).getAttribute('visibility'), 'visible');
  plot.dispatch('pointermove', { target: p.indicatorButtons.rsi, clientX: 967 });
  plot.dispatch('pointermove', { target: p.nodes.get('indicator-guide-body'), clientX: 967 });
  plot.dispatch('keydown', { target: p.indicatorButtons.rsi, key: 'ArrowRight' });
  assert.equal(p.nodes.get('detail').textContent, selected);
  const mainGeometry = main.getAttribute('viewBox');
  p.receive({ type: 'select-indicator', indicator: 'none' });
  assert.equal(p.nodes.get('indicator-chart').hidden, true);
  assert.equal(main.getAttribute('viewBox'), mainGeometry);
  assert.equal(p.nodes.get('chart-tooltip').style.top, '38px');
  p.indicatorButtons.kdj.click();
  assert.equal(p.messages.at(-1).indicator, 'kdj');
  p.receive({ type: 'select-indicator', indicator: 'kdj' });
  assert.equal(p.nodes.get('indicator-chart').hidden, false);
  assert.equal(p.nodes.get('detail').textContent, selected);
  assert.ok(descendants(sub).some((n) => n.getAttribute('class') === 'indicator-line'));
  p.receive({ type: 'select-mode', mode: 'monthly' });
  assert.equal(main.children.length, 0);
  assert.equal(sub.children.length, 0);
});

test('日周月均绘制K线与默认MACD，切换指标无需网络，跨周期保留选择', () => {
  const p = page();
  for (const mode of ['daily', 'weekly', 'monthly']) {
    p.receive({ type: 'select-mode', mode });
    p.receive({
      type: 'data',
      data: {
        symbol: 'sh600105',
        name: '测试股',
        source: '测试',
        mode,
        date: '2026-10-28',
        adjustment: '前复权',
        bars: sampleBars
      }
    });
    assert.equal(p.nodes.get('zoom-tools').hidden, false);
    assert.match(p.nodes.get('meta').textContent, new RegExp({ daily: '日K', weekly: '周K', monthly: '月K' }[mode]));
    assert.ok(descendants(p.nodes.get('indicator-svg')).some((n) => n.getAttribute('class') === 'indicator-bar'));
    assert.doesNotMatch(JSON.stringify(rendered(p).map((n) => n.getAttribute('points'))), /NaN|Infinity/);
  }
  const messages = p.messages.length;
  p.receive({ type: 'select-indicator', indicator: 'rsi' });
  assert.match(p.nodes.get('indicator-detail').textContent, /RSI6.*RSI12.*RSI24/);
  const latest = p.nodes.get('indicator-detail').textContent;
  p.nodes.get('plot').dispatch('keydown', { key: 'ArrowLeft' });
  assert.notEqual(p.nodes.get('indicator-detail').textContent, latest);
  const selected = p.nodes.get('indicator-detail').textContent;
  p.nodes.get('zoom-in').click();
  assert.equal(p.nodes.get('indicator-detail').textContent, selected);
  p.receive({ type: 'select-indicator', indicator: 'none' });
  assert.equal(p.nodes.get('indicator-detail').textContent, '');
  assert.equal(p.nodes.get('indicator-chart').hidden, true);
  assert.equal(p.nodes.get('indicator-svg').children[0].children.length, 0);
  assert.equal(p.messages.length, messages);
  assert.equal(p.writes.length, 0);
});

test('日周月及所有分钟周期悬停同步MA、副图图例、详情卡，历史涨幅使用前一根K线', () => {
  const p = page(),
    plot = () => p.nodes.get('plot');
  for (const mode of ['daily', 'weekly', 'monthly', 'm1', 'm5', 'm15', 'm30', 'm60']) {
    const bars = sampleBars.map((b) => ({ ...b }));
    const data = { symbol: 'sh600105', name: '测试股', mode, date: '2026-10-28', previousClose: 999, bars };
    p.receive({ type: 'select-mode', mode });
    p.receive({ type: 'data', data });
    const before = p.nodes.get('average-detail').textContent;
    // With 180 visible bars, the first bar is absolute index 60.
    plot().dispatch('pointermove', { clientX: 68, clientY: 100 });
    const expected = bars.slice(56, 61).reduce((s, b) => s + b.close, 0) / 5;
    const series = (name) => rendered(p).find((n) => n.getAttribute('data-series') === name).textContent;
    assert.equal(series('MA5'), `MA5 ${expected.toFixed(2)}`);
    assert.notEqual(p.nodes.get('average-detail').textContent, before);
    assert.match(p.nodes.get('chart-tooltip').textContent, new RegExp(bars[60].time));
    assert.match(
      p.nodes.get('chart-tooltip').textContent,
      /MA5.*MA10.*MA20[\s\S]*MA30.*MA60[\s\S]*VMA5.*VMA10[\s\S]*MACD[\s\S]*KDJ[\s\S]*RSI/
    );
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
    p.receive({
      type: 'data',
      data: { ...data, bars: [...bars, { ...bars.at(-1), time: '2026-12-31', close: 50, high: 51 }] }
    });
    assert.equal(p.nodes.get('average-detail').textContent, selected);
    assert.match(p.nodes.get('detail').textContent, new RegExp(bars[60].time));
    plot().dispatch('pointerleave');
    assert.equal(p.nodes.get('chart-tooltip').hidden, true);
    assert.match(p.nodes.get('detail').textContent, /2026-12-31/);
  }
});

test('分时绘制真实成交均价，鼠标定位及跨日刷新不串值；缺字段显示空值', () => {
  const p = page();
  const data = {
    symbol: 'sh600105',
    mode: 'intraday',
    name: '测试股',
    source: '测试',
    date: '2026-10-28',
    previousClose: 10,
    bars: ['0930', '0931', '0932'].map((time, i) => ({
      time,
      open: 10 + i,
      close: 10 + i,
      high: 10 + i,
      low: 10 + i,
      volume: 100,
      cumulativeVolume: 100 * (i + 1),
      amount: 100000 + i * 10000,
      cumulativeAmount: (i + 1) * (100000 + i * 5000),
      averagePrice: 10 + i * 0.5
    }))
  };
  p.receive({ type: 'data', data });
  assert.ok(descendants(p.nodes.get('svg')).some((n) => n.getAttribute('class') === 'intraday-average'));
  p.nodes.get('plot').dispatch('pointermove', { clientX: 68, clientY: 100 });
  assert.match(p.nodes.get('chart-tooltip').textContent, /09:30[\s\S]*均价 10.00[\s\S]*累计额 10.00万元/);
  p.receive({ type: 'data', data });
  assert.match(p.nodes.get('detail').textContent, /09:30/);
  p.receive({ type: 'data', data: { ...data, date: '2026-10-29' } });
  assert.equal(p.nodes.get('chart-tooltip').hidden, true);
  assert.match(p.nodes.get('detail').textContent, /2026-10-29 09:32/);
  p.receive({
    type: 'data',
    data: { ...data, bars: [{ ...data.bars[0], averagePrice: null, amount: null, cumulativeAmount: null }] }
  });
  assert.match(p.nodes.get('average-detail').textContent, /均价 —/);
  assert.doesNotMatch(p.nodes.get('detail').textContent, /NaN|Infinity/);
  assert.ok(!descendants(p.nodes.get('svg')).some((n) => n.getAttribute('class') === 'intraday-average'));
});

test('短分时KDJ提示数据不足、RSI无无效数值，旧股票消息不覆盖当前图', () => {
  const p = page();
  p.receive({ type: 'select-mode', mode: 'intraday' });
  p.receive({
    type: 'data',
    data: {
      symbol: 'sh600105',
      mode: 'intraday',
      name: '测试股',
      source: '测试',
      date: '2026-10-28',
      previousClose: 10,
      bars: [{ ...sampleBars[0], time: '0930' }]
    }
  });
  p.receive({ type: 'select-indicator', indicator: 'kdj' });
  assert.ok(descendants(p.nodes.get('indicator-svg')).some((n) => /数据不足/.test(n.textContent)));
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
  p.advance(1000);
  assert.equal(p.writes.length, 0);
  p.receive({ type: 'select-mode', mode: 'chips' });
  p.advance(400);
  assert.match(p.nodes.get('eastmoney').src, /h5chart-iframe/);
  p.receive({ type: 'select-mode', mode: 'daily' });
  assert.equal(p.nodes.get('web-chart').hidden, true);
  assert.equal(p.nodes.get('local').hidden, false);
  assert.equal(p.nodes.get('eastmoney').getAttribute('src'), null);
  assert.equal(p.messages.at(-1).mode, 'daily');
  p.receive({ type: 'select-mode', mode: 'chips' });
  p.advance(400);
  assert.match(p.nodes.get('eastmoney').src, /h5chart-iframe/);
});
test('不支持筹码的品种使用内置分时，错误令牌不能加载网页', () => {
  const p = page({ chips: false });
  p.receive({ type: 'select-mode', mode: 'chips' });
  assert.equal(p.messages.at(-1).mode, 'intraday');
  p.receive({ type: 'select-mode', mode: 'eastmoney', token: 'wrong' });
  p.advance(400);
  assert.equal(p.nodes.get('local').hidden, false);
  assert.equal(p.writes.length, 0);
  const writes = p.writes.length;
  p.receive({ type: 'refresh', mode: 'eastmoney', token: 'wrong' });
  assert.equal(p.writes.length, writes);
});

test('默认内置图表以及网页加载前切回内置图表，均不会发起第三方导航', () => {
  const p = page();
  p.receive({ type: 'select-mode', mode: 'intraday' });
  p.advance(1000);
  assert.equal(p.nodes.get('local').hidden, false);
  assert.equal(p.writes.length, 0);
  p.receive({ type: 'select-mode', mode: 'eastmoney' });
  p.advance(200);
  p.receive({ type: 'select-mode', mode: 'daily' });
  p.advance(1000);
  assert.equal(p.writes.length, 0);
  assert.equal(p.nodes.get('eastmoney').getAttribute('src'), null);
});

test('就绪前切换及连续网页切换只加载最终选中的一种', () => {
  const p = page({ mode: 'eastmoney' });
  p.advance(1000);
  assert.equal(p.writes.length, 0);
  p.receive({ type: 'select-mode', mode: 'eastmoney' });
  p.advance(200);
  p.receive({ type: 'select-mode', mode: 'chips' });
  p.receive({ type: 'refresh', mode: 'chips' });
  p.advance(400);
  assert.equal(p.writes.length, 1);
  assert.match(p.writes[0], /h5chart-iframe/);
});

test('页面周期按钮向宿主发消息，确认后高亮；点击冒泡不会回到分时', () => {
  const p = page();
  p.receive({ type: 'select-mode', mode: 'intraday' });
  p.buttons.weekly.click();
  assert.equal(p.messages.at(-1).action, 'period');
  assert.equal(p.messages.at(-1).mode, 'weekly');
  p.receive({ type: 'select-mode', mode: 'weekly' });
  assert.equal(p.buttons.weekly.getAttribute('aria-pressed'), 'true');
  assert.equal(p.buttons.intraday.getAttribute('aria-pressed'), 'false');
  const before = p.messages.length;
  p.buttons.monthly.click();
  p.buttons.intraday.click();
  assert.deepEqual(
    p.messages.slice(before).map((m) => m.mode),
    ['monthly', 'intraday']
  );
  p.receive({ type: 'select-mode', mode: 'intraday' });
  assert.equal(p.buttons.intraday.getAttribute('aria-pressed'), 'true');
  p.receive({ type: 'select-mode', mode: 'daily' });
  assert.equal(p.buttons.daily.getAttribute('aria-pressed'), 'true');
  assert.equal(p.writes.length, 0);
});

test('五日分时在页面切换，按交易日分段、悬停日期和每日重置指标', () => {
  const p = page();
  p.buttons.intraday5.click();
  assert.equal(p.messages.at(-1).mode, 'intraday5');
  p.receive({ type: 'select-mode', mode: 'intraday5' });
  assert.equal(p.buttons.intraday5.getAttribute('aria-pressed'), 'true');
  assert.equal(p.nodes.get('zoom-tools').hidden, true);
  const dates = ['2026-10-29', '2026-10-30'];
  const bars = dates.flatMap((date, dayIndex) =>
    [0, 1, 2].map((i) => ({
      time: `${date} 09:3${i}`,
      date,
      dayIndex,
      previousClose: dayIndex ? 11 : null,
      open: 10 + dayIndex + i,
      close: 10 + dayIndex + i,
      high: 10 + dayIndex + i,
      low: 10 + dayIndex + i,
      volume: 100,
      cumulativeVolume: 100 * (i + 1),
      amount: 100000,
      cumulativeAmount: 100000 * (i + 1),
      averagePrice: 10 + dayIndex
    }))
  );
  const data = {
    symbol: 'sh600105',
    mode: 'intraday5',
    name: '测试股',
    source: '测试',
    date: dates[1],
    dates,
    previousClose: 11,
    bars
  };
  p.receive({ type: 'data', data });
  assert.match(p.nodes.get('meta').textContent, /5日分时.*交易日 2 天/);
  assert.equal(descendants(p.nodes.get('svg')).filter((n) => n.getAttribute('class') === 'intraday-price').length, 2);
  p.nodes.get('plot').dispatch('pointermove', { clientX: 77, clientY: 100 });
  assert.match(p.nodes.get('chart-tooltip').textContent, /2026-10-29 09:30[\s\S]*均价 10.00/);
  assert.match(p.nodes.get('detail').textContent, /涨跌 —/);
  p.nodes.get('plot').dispatch('pointermove', { clientX: 527, clientY: 100 });
  assert.match(p.nodes.get('chart-tooltip').textContent, /2026-10-30 09:30[\s\S]*均价 11.00/);
  assert.match(p.nodes.get('indicator-detail').textContent, /DIF 0.0000/);
  p.receive({ type: 'data', data });
  assert.match(p.nodes.get('detail').textContent, /2026-10-30 09:30/);
});
