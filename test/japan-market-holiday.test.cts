const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const { japanCashDay, trustworthyJapanCashQuote } = require('../dist/features/global-indices/japan-calendar');
const { BUILTIN_INDICES, GlobalIndexProvider } = require('../dist/features/global-indices/data');
const { regionalSessions, cashTiming } = require('../dist/features/ai/global-timing');
const { AnalysisEnvironment } = require('../dist/features/ai/environment');
const NOW = Date.parse('2026-11-23T15:00:00+08:00');
const CLOSE = Date.parse('2026-11-20T14:30:00+08:00');
const BAD = Date.parse('2026-11-23T09:30:01+08:00');
function quote(id = '100.N225', timestamp = CLOSE) {
  return {
    ...BUILTIN_INDICES.find((entry) => entry.id === id),
    source: 'sina',
    timestampKind: 'updated',
    price: 56436.65,
    percent: -5.06,
    delta: -3007.56,
    open: 58551.56,
    previousClose: 59444.21,
    high: 58707.48,
    low: 56436.65,
    timestamp: timestamp / 1000
  };
}
function batch(q) {
  return { entries: new Map([[q.id, q]]), quotes: new Map([[q.id, q]]), errors: new Map() };
}
test('日本现货按东京日期和官方快照识别休市，未覆盖年份不猜测工作日', () => {
  const holiday = japanCashDay(new Date(NOW));
  assert.equal(holiday.closed, true);
  assert.equal(holiday.reason, '勤劳感谢日');
  assert.equal(holiday.covered, true);
  assert.equal(japanCashDay(new Date('2027-03-22T01:00:00Z')).closed, true);
  assert.equal(japanCashDay(new Date('2026-11-23T15:30:00Z')).date, '2026-11-24');
  assert.equal(japanCashDay(new Date('2026-11-23T15:30:00Z')).closed, false);
  assert.equal(japanCashDay(new Date('2028-11-23T03:00:00Z')).covered, false);
  assert.equal(trustworthyJapanCashQuote(quote()), true);
  assert.equal(trustworthyJapanCashQuote(quote('100.N225', BAD)), false);
  assert.equal(trustworthyJapanCashQuote(quote('100.KS11', BAD)), true);
  const session = regionalSessions(new Date('2026-11-23T01:00:00Z')).find((row) => row.id === 'jp');
  assert.equal(session.phase, 'closed');
  assert.match(session.basis, /勤劳感谢日/);
  assert.equal(cashTiming('100.N225', BAD / 1000, new Date(BAD + 1000), 'quote').currentReference, false);
  const outsideSnapshot = regionalSessions(new Date('2028-11-23T03:00:00Z')).find((row) => row.id === 'jp');
  assert.match(outsideSnapshot.basis, /节假日快照未覆盖/);
});
test('已存入休市日可疑行情时丢弃该缓存，正常恢复较早的有效收盘行情', async () => {
  const h = harness();
  const bad = { ...quote('100.N225', BAD), price: 59024.23, percent: 4.58 };
  h.store.set('globalIndexQuotes', [bad, quote('100.KS11', BAD)]);
  const { GlobalIndicesController } = h.load('../dist/features/global-indices/controller');
  const c = new GlobalIndicesController(h.context, {
    now: () => new Date(NOW),
    provider: {
      load: async (ids) => {
        const values = [quote(), quote('100.KS11', BAD)].filter((q) => ids.includes(q.id));
        return {
          entries: new Map(values.map((q) => [q.id, q])),
          quotes: new Map(values.map((q) => [q.id, q])),
          errors: new Map()
        };
      }
    }
  });
  try {
    assert.equal(c.quotes.has('100.N225'), false);
    assert.equal(c.quotes.get('100.KS11').price, 56436.65);
    const pending = c.getTreeItem(c.element('100.N225'));
    assert.match(pending.description, /日本休市/);
    assert.doesNotMatch(pending.label, /59024/);
    await c.refresh();
    const row = c.getTreeItem(c.element('100.N225'));
    assert.equal(c.quotes.get('100.N225').price, 56436.65);
    assert.match(row.label, /-5\.06%.*56436\.65/);
    assert.match(row.description, /日本休市.*11-20 14:30/);
    assert.match(row.tooltip.value, /并非今日涨跌/);
    assert.equal(c.errors.has('100.N225'), false);
    assert.equal(h.store.get('globalIndexQuotes').find((q) => q.id === '100.N225').price, 56436.65);
  } finally {
    c.dispose();
  }
});
test('休市日可疑新报价不覆盖已有收盘价，其他市场不受影响', async () => {
  const h = harness();
  h.store.set('globalIndexQuotes', [quote()]);
  const { GlobalIndicesController } = h.load('../dist/features/global-indices/controller');
  const c = new GlobalIndicesController(h.context, {
    now: () => new Date(NOW),
    provider: {
      load: async () => batch({ ...quote('100.N225', BAD), price: 59024.23 })
    }
  });
  try {
    await c.refresh();
    assert.equal(c.quotes.get('100.N225').price, 56436.65);
    assert.match(c.getTreeItem(c.element('100.N225')).description, /获取失败/);
  } finally {
    c.dispose();
  }
});
test('主源休市时间可疑时尝试备用源，返回实际收盘时间且不静默当成实时', async () => {
  const p = new GlobalIndexProvider({
    now: () => NOW,
    request: async () => ({
      rc: 0,
      data: {
        total: 1,
        diff: [
          {
            f13: 100,
            f12: 'N225',
            f14: '日经225',
            f2: 59024.23,
            f3: 4.58,
            f4: 2587.58,
            f17: 58434.04,
            f18: 56436.65,
            f15: 59614.52,
            f16: 57843.79,
            f124: BAD / 1000
          }
        ]
      }
    }),
    requestText: async () =>
      'var hq_str_b_NKY="日经225指数,56436.6500,-3007.56,-5.06,2:12 AM,14:12:00,2026-11-20,14:30:00,58551.56,59444.21,58707.48,56436.65,0";'
  });
  const r = await p.load(['100.N225']);
  assert.equal(r.quotes.get('100.N225').price, 56436.65);
  assert.equal(r.quotes.get('100.N225').timestamp, CLOSE / 1000);
  assert.equal(r.errors.size, 0);
});
test('AI 外围不会发送休市日可疑缓存，且说明日本现货市场休市', async () => {
  const bad = { ...quote('100.N225', BAD), price: 59024.23 };
  const env = new AnalysisEnvironment({
    now: () => new Date(NOW),
    globals: { quotes: new Map([[bad.id, bad]]) },
    globalProvider: { load: async () => batch(bad) },
    commodityProvider: { load: async () => ({ quotes: new Map(), errors: new Map() }) }
  });
  const result = await env.load('sz002714', undefined, undefined, ['global'], { region: 'jp' });
  assert.deepEqual(result.globalMarkets.quotes, []);
  assert.ok(result.globalMarkets.missing.includes('日经225'));
  assert.equal(result.globalMarkets.sessions[0].phase, 'closed');
});
