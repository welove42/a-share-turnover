'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
function setup(mode = 'whenVisible') {
  const h = harness({ 'aShareTurnover.stockAlerts.mode': mode }),
    { StockAlerts } = h.load('../dist/features/watchlist/alerts.js');
  const notices = [];
  h.api.window.showWarningMessage = (text) => {
    notices.push(text);
    return Promise.resolve();
  };
  let now = new Date('2026-11-04T10:30:00+08:00'),
    calls = 0;
  const q = { symbol: 'sh600105', name: '测试股', percent: 7.1, date: '2026-11-04', timestamp: '20261104103000' };
  const stocks = {
    config: { enabled: true, symbols: ['sh600105'], closedDates: [] },
    paused: false,
    quotes: new Map([[q.symbol, q]]),
    stale: () => false,
    provider: {
      load: async () => {
        calls++;
        return { quotes: new Map([[q.symbol, q]]), errors: new Map() };
      }
    },
    overseas: { symbols: { hk: ['hk00700'], us: [] }, quotes: new Map(), stale: () => false, request: async () => '' }
  };
  const c = new StockAlerts(h.context, stocks, { now: () => now });
  return {
    h,
    c,
    notices,
    stocks,
    q,
    setNow: (date) => {
      now = new Date(date);
    },
    calls: () => calls,
    StockAlerts
  };
}

function limitQuote(price, seconds = 0, extra = {}) {
  const local = new Date(Date.parse('2026-11-04T10:30:00+08:00') + (seconds + 8 * 3600) * 1000).toISOString();
  return {
    symbol: 'sh600105',
    name: '测试股',
    price,
    priceText: price.toFixed(2),
    previousClose: 10,
    percent: (price / 10 - 1) * 100,
    high: 11,
    low: 9,
    limitUp: 11,
    limitDown: 9,
    date: local.slice(0, 10),
    timestamp: local.slice(0, 19).replace(/[-:T]/g, ''),
    ...extra
  };
}
function pushLimit(s, price, seconds = 0, extra = {}) {
  s.setNow(new Date(Date.parse('2026-11-04T10:30:00+08:00') + seconds * 1000));
  s.c.check([limitQuote(price, seconds, extra)], 'a');
}

test('涨跌停与7%同次合并，四类事件分别每日去重，重启不回放炸板', async () => {
  const s = setup();
  try {
    pushLimit(s, 11);
    assert.equal(s.notices.length, 1);
    assert.match(s.notices[0], /涨停.*11.00 元/);
    assert.doesNotMatch(s.notices[0], /上涨/);
    pushLimit(s, 11, 10);
    assert.equal(s.notices.length, 1);
    pushLimit(s, 10.99, 20);
    assert.match(s.notices[1], /涨停炸板/);
    pushLimit(s, 9, 30);
    assert.match(s.notices[2], /跌停/);
    pushLimit(s, 9.01, 40);
    assert.match(s.notices[3], /跌停炸板/);
    pushLimit(s, 11, 50);
    pushLimit(s, 10, 60);
    pushLimit(s, 9, 70);
    pushLimit(s, 10, 80);
    assert.equal(s.notices.length, 4);
    await s.c.write;
    const other = new s.StockAlerts(s.h.context, s.stocks, { now: () => new Date('2026-11-04T10:32:00+08:00') });
    other.check([limitQuote(10, 120)], 'a');
    other.check([limitQuote(11, 120)], 'a');
    assert.equal(s.notices.length, 4);
    other.dispose();
    pushLimit(s, 11, 86400);
    assert.equal(s.notices.length, 5);
    assert.match(s.notices[4], /涨停/);
  } finally {
    s.c.dispose();
  }
});

test('独立开关和三种模式生效，隐藏或暂停后不跨中断报炸板；港美仅原7%提醒', async () => {
  const s = setup();
  try {
    await s.h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.limitEvents', false);
    pushLimit(s, 11);
    assert.match(s.notices[0], /上涨/);
    assert.doesNotMatch(s.notices[0], /涨停/);
    await s.h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.limitEvents', true);
    pushLimit(s, 11, 10);
    assert.match(s.notices[1], /涨停/);
    s.c.setHidden(true);
    pushLimit(s, 10, 20);
    s.c.setHidden(false);
    pushLimit(s, 10, 30);
    assert.equal(s.notices.length, 2);
    pushLimit(s, 11, 40);
    s.stocks.paused = true;
    await s.c.tick();
    s.stocks.paused = false;
    pushLimit(s, 10, 50);
    assert.equal(s.notices.length, 2);
    s.c.check([limitQuote(11, 50, { symbol: 'hk00700' })], 'hk');
    assert.match(s.notices.at(-1), /上涨/);
    assert.doesNotMatch(s.notices.at(-1), /涨停/);
    await s.h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.mode', 'never');
    pushLimit(s, 9, 60);
    assert.equal(s.notices.length, 3);
  } finally {
    s.c.dispose();
  }
});

test('失败缓存和盘前报价不触发或续接开板，低于7%的限价事件也独立通知', async () => {
  const s = setup();
  try {
    pushLimit(s, 11, 0, { cached: true });
    assert.equal(s.notices.length, 0);
    pushLimit(s, 10.5, 10, { limitUp: 10.5, limitDown: 9.5, high: 10.5, low: 9.5 });
    assert.match(s.notices[0], /涨停/);
    s.stocks.stale = () => true;
    await s.c.tick();
    s.stocks.stale = () => false;
    pushLimit(s, 10, 20, { limitUp: 10.5, limitDown: 9.5, high: 10.5, low: 9.5 });
    assert.equal(s.notices.length, 1);
    s.setNow('2026-11-05T09:25:00+08:00');
    s.c.check(
      [
        limitQuote(10.5, 0, {
          date: '2026-11-05',
          timestamp: '20261105092500',
          limitUp: 10.5,
          limitDown: 9.5,
          high: 10.5,
          low: 9.5
        })
      ],
      'a'
    );
    assert.equal(s.notices.length, 1);
  } finally {
    s.c.dispose();
  }
});

test('一直提醒模式在老板键下继续检测涨跌停转移，源错误后不补发开板', async () => {
  const s = setup('always');
  let current = limitQuote(11),
    failed = false;
  s.stocks.provider.load = async () => ({
    quotes: new Map([[current.symbol, current]]),
    errors: new Map(failed ? [[current.symbol, '断网']] : [])
  });
  try {
    s.c.setHidden(true);
    await s.c.tick();
    current = limitQuote(10.99, 10);
    s.setNow('2026-11-04T10:30:10+08:00');
    await s.c.tick();
    assert.match(s.notices[1], /涨停炸板/);
    current = limitQuote(9, 20);
    s.setNow('2026-11-04T10:30:20+08:00');
    await s.c.tick();
    failed = true;
    s.setNow('2026-11-04T10:30:30+08:00');
    await s.c.tick();
    failed = false;
    current = limitQuote(9.01, 40);
    s.setNow('2026-11-04T10:30:40+08:00');
    await s.c.tick();
    assert.equal(s.notices.length, 3);
  } finally {
    s.c.dispose();
  }
});
test('严格超过7%才提醒，当天同方向去重且重启保留；反向和次日可再次提醒', async () => {
  const { h, c, notices, stocks, q, StockAlerts, setNow } = setup();
  try {
    c.check(
      [
        { ...q, percent: 7 },
        { ...q, percent: -7 }
      ],
      'a'
    );
    assert.equal(notices.length, 0);
    await c.tick();
    await c.tick();
    assert.equal(notices.length, 1);
    await c.write;
    const other = new StockAlerts(h.context, stocks, { now: () => new Date('2026-11-04T10:30:00+08:00') });
    other.check([q], 'a');
    assert.equal(notices.length, 1);
    other.dispose();
    c.check([{ ...q, percent: -7.01 }], 'a');
    assert.equal(notices.length, 2);
    setNow('2026-11-05T10:30:00+08:00');
    c.check([{ ...q, date: '2026-11-05', timestamp: '20261105103000' }], 'a');
    assert.equal(notices.length, 3);
  } finally {
    c.dispose();
  }
});
test('旧行情、非自选、休市和暂停不弹窗；默认老板键静默，不消耗当天提醒', async () => {
  const { c, notices, stocks, q, setNow } = setup();
  try {
    c.check(
      [
        { ...q, timestamp: '20261104100000' },
        { ...q, date: '2026-11-03' },
        { ...q, symbol: 'sh000001' }
      ],
      'a'
    );
    assert.equal(notices.length, 0);
    c.setHidden(true);
    await c.tick();
    assert.equal(notices.length, 0);
    c.setHidden(false);
    stocks.paused = true;
    await c.tick();
    assert.equal(notices.length, 0);
    stocks.paused = false;
    setNow('2026-11-04T12:00:00+08:00');
    c.check([q], 'a');
    assert.equal(notices.length, 0);
    setNow('2026-11-04T10:30:00+08:00');
    await c.tick();
    assert.equal(notices.length, 1);
  } finally {
    c.dispose();
  }
});
test('一直提醒在老板键下继续获取自选行情，关闭模式停止；港股也可提醒', async () => {
  const { c, h, notices, q, calls } = setup('always');
  try {
    c.setHidden(true);
    await c.tick();
    assert.equal(calls(), 1);
    assert.equal(notices.length, 1);
    await c.tick();
    assert.equal(calls(), 1);
    c.check([{ ...q, symbol: 'hk00700', name: '腾讯' }], 'hk');
    assert.equal(notices.length, 2);
    await h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.mode', 'never');
    c.check([{ ...q, percent: -9 }], 'a');
    await c.tick();
    assert.equal(notices.length, 2);
    assert.equal(calls(), 1);
  } finally {
    c.dispose();
  }
});
test('关闭提醒后迟到的后台请求不弹窗；美股使用美东交易日和报价时间', async () => {
  const { c, h, stocks, q, notices, setNow } = setup('always');
  let finish;
  try {
    stocks.provider.load = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    c.setHidden(true);
    const pending = c.tick();
    await h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.mode', 'never');
    finish({ quotes: new Map([[q.symbol, q]]), errors: new Map() });
    await pending;
    assert.equal(notices.length, 0);
    await h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.mode', 'whenVisible');
    c.setHidden(false);
    stocks.overseas.symbols.us = ['usAAPL'];
    setNow('2026-11-05T00:00:00+08:00');
    c.check([{ ...q, symbol: 'usAAPL', date: '2026-11-04', timestamp: '20261104110000' }], 'us');
    assert.equal(notices.length, 1);
  } finally {
    c.dispose();
  }
});
