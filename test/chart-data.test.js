'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { eastmoneyUrl, eastmoneyChartUrl, supportsChips, parseChart, ChartProvider } = require('../src/chart-data');
const symbol = 'sh600519';
const wrap = data => ({ code: 0, data: { [symbol]: data } });
test('东方财富区分个股、沪深指数和北交所路径，拒绝URL注入', () => {
  assert.equal(eastmoneyUrl('600519.SH'), 'https://quote.eastmoney.com/sh600519.html');
  assert.equal(eastmoneyUrl('000001'), 'https://quote.eastmoney.com/sz000001.html');
  assert.equal(eastmoneyUrl('sh000001'), 'https://quote.eastmoney.com/zs000001.html');
  assert.equal(eastmoneyUrl('sz399001'), 'https://quote.eastmoney.com/zs399001.html');
  assert.equal(eastmoneyUrl('bj920002'), 'https://quote.eastmoney.com/bj/920002.html');
  assert.throws(() => eastmoneyUrl('https://evil.example/'));
});
test('专用图表正确映射沪深及北交所；筹码盘口只向沪深A股开放', () => {
  assert.equal(eastmoneyChartUrl('sh600105'), 'https://quote.eastmoney.com/basic/full.html?mcid=1.600105');
  assert.equal(eastmoneyChartUrl('000001'), 'https://quote.eastmoney.com/basic/full.html?mcid=0.000001');
  assert.equal(eastmoneyChartUrl('sh000001'), 'https://quote.eastmoney.com/basic/full.html?mcid=1.000001');
  assert.equal(eastmoneyChartUrl('bj920002'), 'https://quote.eastmoney.com/basic/full.html?mcid=0.920002');
  for (const symbol of ['sh600105', 'sh688001', 'sz000001', 'sz002594', 'sz300750', 'sz301001']) {
    assert.equal(supportsChips(symbol), true);
    assert.equal(eastmoneyChartUrl(symbol, 'chips'), `https://quote.eastmoney.com/basic/h5chart-iframe.html?code=${symbol.slice(2)}&market=${symbol.startsWith('sh') ? 1 : 0}`);
  }
  for (const symbol of ['sh000001', 'sz399001', 'sh510300', 'sz159915', 'bj920002']) {
    assert.equal(supportsChips(symbol), false);
    assert.equal(eastmoneyChartUrl(symbol, 'chips'), eastmoneyChartUrl(symbol));
  }
  assert.throws(() => eastmoneyChartUrl('https://evil.example'));
});
test('分时成交量为累计值，图表柱使用相邻差额；跳过集合竞价与零价格', () => {
  const result = parseChart(wrap({ data: { date: '20261026', data: ['0925 0 0', '0930 10.01 100', '0931 10.02 140', '0932 10.02 140', '1300 10.03 220'] } }), symbol, 'intraday');
  assert.deepEqual(result.bars.map(b => b.volume), [100, 40, 0, 80]);
  assert.equal(result.bars[1].close, 10.02); assert.equal(result.date, '2026-10-26');
  assert.throws(() => parseChart(wrap({ data: { date: '20261026', data: ['0930 10 100', '0931 10 99'] } }), symbol, 'intraday'), /顺序/);
});
test('日K按照开收高低字段解析，优先前复权，指数无复权时明确标记', () => {
  const rows = [['2026-10-23', '10', '11', '12', '9', '1000'], ['2026-10-26', '11', '10', '11.5', '9.5', '2000']];
  const qfq = parseChart(wrap({ qfqday: rows }), symbol, 'daily');
  assert.equal(qfq.adjustment, '前复权'); assert.deepEqual(qfq.bars[0], { time: '2026-10-23', open: 10, close: 11, high: 12, low: 9, volume: 1000 });
  assert.equal(parseChart(wrap({ day: rows }), symbol, 'daily').adjustment, '不复权');
  assert.throws(() => parseChart(wrap({ day: [['2026-10-26', '10', '11', '9', '8', '100']] }), symbol, 'daily'), /价格/);
  assert.throws(() => parseChart(wrap({ day: [['2026-02-30', '10', '11', '12', '9', '100']] }), symbol, 'daily'), /日期/);
  assert.throws(() => parseChart(wrap({ day: [] }), symbol, 'daily'), /暂无/);
});
test('图表请求只使用已校验代码与固定数据域名，取消信号传递到底层', async () => {
  const signal = new AbortController().signal, calls = [];
  const provider = new ChartProvider(async (url, s) => { calls.push([url, s]); return wrap({ day: [['2026-10-26', '10', '11', '12', '9', '100']] }); });
  await provider.load('600519', 'daily', signal);
  assert.match(calls[0][0], /^https:\/\/web\.ifzq\.gtimg\.cn\/appstock\/app\/fqkline\/get\?param=sh600519,/); assert.equal(calls[0][1], signal);
  await assert.rejects(provider.load('600519', 'other', signal), /类型/);
});
