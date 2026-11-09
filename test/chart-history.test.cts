const test = require('node:test');
const assert = require('node:assert/strict');
const { prependHistory, retainHistory } = require('../dist/features/charts/history.js');
const { parseChart, ChartProvider } = require('../dist/features/charts/data.js');
const bar = (time, close = 10) => ({ time, open: close, close, high: close + 1, low: close - 1, volume: 100 });
const series = (bars, extra = {}) => ({ symbol: 'sh601766', mode: 'daily', adjustment: '前复权', bars, ...extra });
const wrap = (rows, key = 'qfqday') => ({ code: 0, data: { sh601766: { [key]: rows } } });

test('日周月历史解析保留整页，历史空页与异常响应区分', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => [
    new Date(Date.UTC(2008, 0, i + 1)).toISOString().slice(0, 10),
    10,
    10,
    11,
    9,
    100
  ]);
  for (const [mode, key] of [
    ['daily', 'qfqday'],
    ['weekly', 'qfqweek'],
    ['monthly', 'qfqmonth']
  ])
    assert.equal(parseChart(wrap(rows, key), 'sh601766', mode).bars.length, 1000);
  assert.equal(parseChart(wrap([], 'day'), 'sh601766', 'daily', true).bars.length, 0);
  assert.throws(() => parseChart(wrap([]), 'sh601766', 'daily'), /无|缺|不可用/);
  assert.throws(() => parseChart({ data: {} }, 'sh601766', 'daily', true));
});

test('历史分页请求包含截止日期、正确周期和640根，非法参数及取消不联网', async () => {
  const urls = [];
  const p = new ChartProvider(async (url) => {
    urls.push(url);
    return wrap([], 'week');
  });
  assert.equal((await p.loadEarlier('sh601766', 'weekly', '2008-08-18')).bars.length, 0);
  assert.match(urls[0], /sh601766,week,,2008-08-18,640,qfq/);
  await assert.rejects(p.loadEarlier('sh601766', 'daily', '2008-02-31'));
  await assert.rejects(p.loadEarlier('sh601766', 'intraday', '2008-08-18'));
  await assert.rejects(p.loadEarlier('sh601766', 'daily', '2008-08-18', AbortSignal.abort()), /取消/);
  assert.equal(urls.length, 1);
});

test('补载按日期合并边界，保留最新字段，空页或无进展结束', () => {
  const current = series([bar('2024-01-02'), bar('2024-01-03')], { price: 12 });
  const result = prependHistory(current, series([bar('2008-08-18'), bar('2024-01-02')]));
  assert.deepEqual(
    result.bars.map((b) => b.time),
    ['2008-08-18', '2024-01-02', '2024-01-03']
  );
  assert.equal(result.price, 12);
  assert.equal(result.historyComplete, false);
  assert.equal(prependHistory(result, series([])).historyComplete, true);
  assert.equal(prependHistory(result, series([bar('2008-08-18')])).historyComplete, true);
  assert.equal(current.bars.length, 2);
});

test('不同证券、周期、复权及错误日期范围拒绝拼接', () => {
  const current = series([bar('2024-01-02')]);
  for (const older of [
    series([bar('2024-01-02', 11)]),
    series([bar('2024-01-03')]),
    series([bar('2008-08-18')], { adjustment: '不复权' }),
    series([], { symbol: 'sz000001' }),
    series([], { mode: 'weekly' })
  ])
    assert.throws(() => prependHistory(current, older));
});

test('刷新保留早期历史和换手率、更新最新价格，除权变化清除旧基准', () => {
  const previous = series([bar('2008-08-18'), { ...bar('2024-01-02'), historicalTurnover: 3.2 }, bar('2024-01-03')], {
    historyComplete: true
  });
  const fresh = series([bar('2024-01-02'), bar('2024-01-03', 12)]);
  const result = retainHistory(previous, fresh);
  assert.equal(result.bars.length, 3);
  assert.equal(result.bars[1].historicalTurnover, 3.2);
  assert.equal(result.bars[2].close, 12);
  assert.equal(result.historyComplete, true);
  const reset = retainHistory(previous, series([bar('2024-01-02', 9), bar('2024-01-03', 11)]));
  assert.equal(reset.historyReset, true);
  assert.equal(reset.historyComplete, false);
  assert.equal(reset.bars.length, 2);
  assert.equal(retainHistory(previous, { ...fresh, mode: 'weekly' }).bars.length, 2);
});
