'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
function setup(mode = 'whenVisible') {
  const h = harness({ 'aShareTurnover.stockAlerts.mode': mode }), { StockAlerts } = h.load('../src/stock-alerts');
  const notices = []; h.api.window.showWarningMessage = text => { notices.push(text); return Promise.resolve(); };
  let now = new Date('2026-11-04T10:30:00+08:00'), calls = 0;
  const q = { symbol: 'sh600105', name: '测试股', percent: 7.1, date: '2026-11-04', timestamp: '20261104103000' };
  const stocks = { config: { enabled: true, symbols: ['sh600105'], closedDates: [] }, paused: false, quotes: new Map([[q.symbol, q]]), stale: () => false,
    provider: { load: async () => { calls++; return { quotes: new Map([[q.symbol, q]]), errors: new Map() }; } },
    overseas: { symbols: { hk: ['hk00700'], us: [] }, quotes: new Map(), stale: () => false, request: async () => '' } };
  const c = new StockAlerts(h.context, stocks, { now: () => now });
  return { h, c, notices, stocks, q, setNow: date => { now = new Date(date); }, calls: () => calls, StockAlerts };
}
test('严格超过7%才提醒，当天同方向去重且重启保留；反向和次日可再次提醒', async () => {
  const { h, c, notices, stocks, q, StockAlerts, setNow } = setup();
  try {
    c.check([{ ...q, percent: 7 }, { ...q, percent: -7 }], 'a'); assert.equal(notices.length, 0);
    await c.tick(); await c.tick(); assert.equal(notices.length, 1); await c.write;
    const other = new StockAlerts(h.context, stocks, { now: () => new Date('2026-11-04T10:30:00+08:00') });
    other.check([q], 'a'); assert.equal(notices.length, 1); other.dispose();
    c.check([{ ...q, percent: -7.01 }], 'a'); assert.equal(notices.length, 2);
    setNow('2026-11-05T10:30:00+08:00'); c.check([{ ...q, date: '2026-11-05', timestamp: '20261105103000' }], 'a'); assert.equal(notices.length, 3);
  } finally { c.dispose(); }
});
test('旧行情、非自选、休市和暂停不弹窗；默认老板键静默，不消耗当天提醒', async () => {
  const { c, notices, stocks, q, setNow } = setup();
  try {
    c.check([{ ...q, timestamp: '20261104100000' }, { ...q, date: '2026-11-03' }, { ...q, symbol: 'sh000001' }], 'a'); assert.equal(notices.length, 0);
    c.setHidden(true); await c.tick(); assert.equal(notices.length, 0); c.setHidden(false);
    stocks.paused = true; await c.tick(); assert.equal(notices.length, 0); stocks.paused = false;
    setNow('2026-11-04T12:00:00+08:00'); c.check([q], 'a'); assert.equal(notices.length, 0);
    setNow('2026-11-04T10:30:00+08:00'); await c.tick(); assert.equal(notices.length, 1);
  } finally { c.dispose(); }
});
test('一直提醒在老板键下继续获取自选行情，关闭模式停止；港股也可提醒', async () => {
  const { c, h, notices, q, calls } = setup('always');
  try {
    c.setHidden(true); await c.tick(); assert.equal(calls(), 1); assert.equal(notices.length, 1);
    await c.tick(); assert.equal(calls(), 1);
    c.check([{ ...q, symbol: 'hk00700', name: '腾讯' }], 'hk'); assert.equal(notices.length, 2);
    await h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.mode', 'never');
    c.check([{ ...q, percent: -9 }], 'a'); await c.tick(); assert.equal(notices.length, 2); assert.equal(calls(), 1);
  } finally { c.dispose(); }
});
test('关闭提醒后迟到的后台请求不弹窗；美股使用美东交易日和报价时间', async () => {
  const { c, h, stocks, q, notices, setNow } = setup('always'); let finish;
  try {
    stocks.provider.load = () => new Promise(resolve => { finish = resolve; });
    c.setHidden(true); const pending = c.tick();
    await h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.mode', 'never');
    finish({ quotes: new Map([[q.symbol, q]]), errors: new Map() }); await pending; assert.equal(notices.length, 0);
    await h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.mode', 'whenVisible'); c.setHidden(false);
    stocks.overseas.symbols.us = ['usAAPL']; setNow('2026-11-05T00:00:00+08:00');
    c.check([{ ...q, symbol: 'usAAPL', date: '2026-11-04', timestamp: '20261104110000' }], 'us'); assert.equal(notices.length, 1);
  } finally { c.dispose(); }
});
