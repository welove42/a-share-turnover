const test = require('node:test');
const assert = require('node:assert/strict');
const { withLiveQuote } = require('../dist/features/charts/live');
const { retainHistory, prependHistory } = require('../dist/features/charts/history');
const bar = (time, volume = 100) => ({
  time,
  open: 10,
  close: 11,
  high: 12,
  low: 9,
  volume,
  amount: 1000,
  historicalTurnover: 1
});
const series = (mode = 'daily', bars = [bar('2026-11-09'), bar('2026-11-10')]) => ({
  symbol: 'sh600519',
  mode,
  bars,
  sourceId: 'eastmoney:qfq',
  source: '东方财富',
  adjustment: '前复权',
  klineFetchedAt: 1000
});
const quote = (volume = 200) => ({
  symbol: 'sh600519',
  date: '2026-11-10',
  timestamp: '20261110103000',
  price: 13,
  open: 11,
  high: 14,
  low: 10,
  volume,
  amount: 2500,
  turnoverRate: 2,
  previousClose: 11
});

test('当日日K按报价替换OHLC和累计量，重刷不重复累计', () => {
  const a = withLiveQuote(series(), quote());
  assert.equal(a.bars.length, 2);
  assert.equal(a.bars.at(-1).high, 14);
  assert.equal(a.bars.at(-1).volume, 200);
  const b = withLiveQuote(a, quote(300));
  assert.equal(b.bars.at(-1).volume, 300);
  assert.equal(b.dailyHigh, 14);
  assert.equal(b.klineFetchedAt, 1000);
  assert.equal(series().bars.at(-1).close, 11);
});

test('周月按完整历史日线加当前日汇总，不把当日量多次加入', () => {
  for (const mode of ['weekly', 'monthly']) {
    const s = series(mode, [bar('2026-11-06'), bar('2026-11-10', 200)]),
      daily = series();
    const a = withLiveQuote(s, quote(), daily),
      b = withLiveQuote(a, quote(250), daily);
    assert.equal(a.bars.at(-1).volume, 300);
    assert.equal(b.bars.at(-1).volume, 350);
    assert.equal(a.bars.at(-1).open, 10);
    assert.equal(a.bars.at(-1).high, 14);
    assert.equal(a.bars.at(-1).low, 9);
    assert.equal(a.bars.at(-1).historicalTurnover, 3);
    assert.equal(a.bars.at(-1).amount, 3500);
  }
});

test('过时、错代码、错误时间和缺少日线的报价不覆盖图表', () => {
  const s = withLiveQuote(series(), quote());
  for (const q of [
    { ...quote(), timestamp: '20261110100000' },
    quote(99),
    { ...quote(), symbol: 'sz000001' },
    { ...quote(), timestamp: '20261110256000' },
    { ...quote(), date: '2026-11-09' },
    { ...quote(), open: null }
  ])
    assert.equal(withLiveQuote(s, q), s);
  const week = series('weekly');
  assert.equal(withLiveQuote(week, quote(), { ...series(), sourceId: 'tencent:qfq' }), week);
  assert.equal(withLiveQuote(week, quote(), series('daily', [bar('2026-11-09')])), week);
});

test('缓存刷新不倒退实时K线；周月日期推进替换同周期，源变化丢弃旧基准', () => {
  const live = withLiveQuote(series(), quote());
  const cached = retainHistory(live, { ...series(), klineStale: true, klineWarning: '使用缓存' });
  assert.equal(cached.bars.at(-1).close, 13);
  assert.equal(cached.timestamp, quote().timestamp);
  assert.equal(cached.klineStale, true);
  const old = series('weekly', [bar('2026-11-06'), bar('2026-11-09')]);
  const fresh = { ...series('weekly', [bar('2026-11-10', 250)]), klineFetchedAt: 2000 };
  assert.deepEqual(
    retainHistory(old, fresh).bars.map((b) => b.time),
    ['2026-11-06', '2026-11-10']
  );
  const switched = { ...fresh, sourceId: 'tencent:qfq' };
  assert.equal(retainHistory(old, switched).historyReset, true);
  assert.throws(() => prependHistory(old, { ...series('weekly', []), sourceId: 'tencent:qfq' }), /来源/);
});
