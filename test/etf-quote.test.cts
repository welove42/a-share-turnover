const test = require('node:test'),
  assert = require('node:assert/strict');
const { parseEtfQuote } = require('../dist/features/funds/etf-quote.js');
const { parseQuotes } = require('../dist/features/watchlist/quotes.js');
const { parseChart, parseFiveDayChart } = require('../dist/features/charts/data.js');

function fields(patch = {}) {
  const q = Array(90).fill('');
  Object.assign(
    q,
    {
      1: '沪深300ETF',
      2: '510300',
      3: '4.145',
      4: '4.124',
      30: '20261109103029',
      61: 'ETF',
      77: '0.11',
      78: '4.1404',
      81: '4.1312'
    },
    patch
  );
  return q;
}

test('ETF 折溢价来自同一腾讯快照；保留真实时间，不使用正式净值替代 IOPV', () => {
  const q = fields(),
    etf = parseEtfQuote('sh510300', q);
  assert.equal(etf.price, 4.145);
  assert.equal(etf.iopv, 4.1404);
  assert.equal(etf.premiumRate, 0.11);
  assert.equal(etf.timestampMs, Date.parse('2026-11-09T10:30:29+08:00'));
  const batch = parseQuotes(`v_sh510300="${q.join('~')}";`, ['sh510300']);
  assert.deepEqual(batch.quotes.get('sh510300').etf, etf);
  for (const bad of ['', '0', '-1', '--', 'Infinity', 'NaN']) {
    const missing = parseEtfQuote('sh510300', fields({ 78: bad }));
    assert.equal(missing.iopv, null);
    assert.equal(missing.premiumRate, null);
    assert.match(missing.notice, /暂无有效 IOPV/);
  }
});

test('折价、平价和缺失源溢价率可计算；字段冲突、停牌无价不伪造数值', () => {
  assert.equal(parseEtfQuote('sh510300', fields({ 3: '0.99', 78: '1', 77: '-1' })).premiumRate, -1);
  assert.equal(parseEtfQuote('sh510300', fields({ 3: '1', 78: '1', 77: '0' })).premiumRate, 0);
  assert.ok(Math.abs(parseEtfQuote('sh510300', fields({ 3: '1.02', 78: '1', 77: '' })).premiumRate - 2) < 1e-8);
  const inconsistent = parseEtfQuote('sh510300', fields({ 77: '20' }));
  assert.equal(inconsistent.premiumRate, null);
  assert.match(inconsistent.notice, /不一致/);
  const halted = parseEtfQuote('sh510300', fields({ 3: '0' }));
  assert.equal(halted.price, null);
  assert.equal(halted.premiumRate, null);
  assert.equal(halted.iopv, 4.1404);
});

test('LOF、股票、指数和错代码不误认 ETF，非法时间不展示参考数值', () => {
  for (const [symbol, patch] of [
    ['sh600519', { 2: '600519' }],
    ['sh000001', { 2: '000001' }],
    ['sz161725', { 2: '161725', 61: 'LOF' }],
    ['sh510300', { 2: '159915' }]
  ])
    assert.equal(parseEtfQuote(symbol, fields(patch)), undefined);
  for (const time of ['', '20260230103000', '20261109250000', '20261109103060']) {
    const etf = parseEtfQuote('sh510300', fields({ 30: time }));
    assert.equal(etf.iopv, null);
    assert.equal(etf.quoteTimestamp, null);
    assert.match(etf.notice, /时间无效/);
  }
  assert.equal(parseEtfQuote('sz159915', fields({ 2: '159915' })).symbol, 'sz159915');
});

test('分时、五日分时、分钟及日周月 K 线复用 ETF 报价，不混用复权历史收盘价', () => {
  const symbol = 'sh510300',
    qt = { [symbol]: fields() };
  const base = { qt, data: { date: '20261109', data: ['0930 4.145 100 41450'] } };
  const wrap = (value) => ({ code: 0, data: { [symbol]: value } });
  assert.equal(parseChart(wrap(base), symbol, 'intraday').etf.premiumRate, 0.11);
  assert.equal(parseFiveDayChart(wrap({ qt, data: [base.data] }), symbol).etf.iopv, 4.1404);
  for (const [mode, key, time] of [
    ['daily', 'qfqday', '2026-11-06'],
    ['weekly', 'qfqweek', '2026-11-06'],
    ['monthly', 'qfqmonth', '2026-11-06'],
    ['m5', 'm5', '202611091005']
  ]) {
    const chart = parseChart(wrap({ qt, [key]: [[time, '1', '1', '1', '1', '100']] }), symbol, mode);
    assert.equal(chart.etf.price, 4.145);
    assert.equal(chart.bars[0].close, 1);
  }
  assert.equal(
    parseChart(wrap({ ...base, qt: { [symbol]: fields({ 61: 'LOF' }) } }), symbol, 'intraday').etfEligible,
    false
  );
});
