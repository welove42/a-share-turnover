'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  COMMODITIES,
  DEFAULT_COMMODITY_CODES,
  normalizeCommodityCodes,
  parseCommodityQuotes,
  CommodityProvider,
  commodityUrl
} = require('../dist/features/commodities/data.js');
function line(code, overrides = {}) {
  const fields = [
    '110.125',
    '',
    '110.1',
    '110.2',
    '111.5',
    '109.2',
    '13:50:00',
    '100',
    '109.5',
    '0',
    '0',
    '0',
    '2026-10-27',
    '来源名称'
  ];
  for (const [index, value] of Object.entries(overrides)) fields[index] = value;
  return `var hq_str_hf_${code}="${fields.join(',')}";`;
}
test('商品默认四项顺序固定，前缀大小写去重，目录有额外候选但不自动选入', () => {
  assert.deepEqual(DEFAULT_COMMODITY_CODES, ['XAU', 'OIL', 'CAD', 'XAG']);
  assert.equal(COMMODITIES.length, 17);
  assert.deepEqual(normalizeCommodityCodes('hf_xau,oil，CAD;XAU'), ['XAU', 'OIL', 'CAD']);
  assert.deepEqual(normalizeCommodityCodes([]), []);
  for (const value of [null, [7], 'XAU&list=CL', 'USD', ['https://evil.test']])
    assert.throws(() => normalizeCommodityCodes(value));
  assert.equal(commodityUrl('XAU'), 'https://finance.sina.com.cn/futures/quotes/XAU.shtml');
  assert.throws(() => commodityUrl('../x'));
});
test('按来源昨收计算涨跌、保留三位精度和跨时区时间；非所选商品不混入', () => {
  const result = parseCommodityQuotes([line('OIL'), line('XAU'), line('CAD', { 0: '98.250' })].join('\n'), [
    'OIL',
    'CAD'
  ]);
  assert.equal(result.errors.size, 0);
  assert.equal(result.quotes.size, 2);
  const q = result.quotes.get('OIL');
  assert.equal(q.priceText, '110.125');
  assert.equal(q.price, 110.125);
  assert.equal(q.percent, 10.125);
  assert.equal(q.open, 109.5);
  assert.equal(q.previousClose, 100);
  assert.equal(q.timestamp, Date.parse('2026-10-27T05:50:00Z') / 1000);
  assert.ok(Math.abs(result.quotes.get('CAD').percent + 1.75) < 1e-10);
});
test('单品种缺失或异常不丢其他报价，不执行响应里的脚本；缺昨收不假报0%', () => {
  const r = parseCommodityQuotes(
    [line('OIL'), 'var hq_str_hf_XAU="";', line('CAD', { 12: '2026-02-30' }), 'throw new Error("must not run");'].join(
      '\n'
    ),
    DEFAULT_COMMODITY_CODES
  );
  assert.deepEqual([...r.quotes.keys()], ['OIL']);
  assert.deepEqual([...r.errors.keys()].sort(), ['CAD', 'XAG', 'XAU']);
  for (const value of ['', '0', 'NaN']) {
    const q = parseCommodityQuotes(line('XAU', { 7: value }), ['XAU']).quotes.get('XAU');
    assert.equal(q.percent, null);
  }
  for (const overrides of [{ 0: '' }, { 0: 'Infinity' }, { 6: '24:01:00' }, { 12: '' }])
    assert.equal(parseCommodityQuotes(line('XAU', overrides), ['XAU']).errors.size, 1);
  const negative = parseCommodityQuotes(line('OIL', { 0: '-1.000' }), ['OIL']).quotes.get('OIL');
  assert.equal(negative.price, -1);
  assert.equal(negative.percent, -101);
});
test('只请求所选代码且合并为一次请求，空列表不访问网络，取消丢弃迟到结果', async () => {
  const calls = [],
    abort = new AbortController();
  const provider = new CommodityProvider({
    request: async (url, signal, headers) => {
      calls.push({ url, signal, headers });
      return Buffer.from(line('XAU'));
    }
  });
  await provider.load([]);
  assert.equal(calls.length, 0);
  const r = await provider.load(['XAU'], abort.signal);
  assert.equal(r.quotes.size, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hq.sinajs.cn/list=hf_XAU');
  assert.equal(calls[0].headers.Referer, 'https://finance.sina.com.cn/');
  provider.request = async () => {
    abort.abort();
    return Buffer.from(line('XAU'));
  };
  await assert.rejects(provider.load(['XAU'], abort.signal), /取消/);
});
function domesticLine(code, overrides = {}) {
  const fields = [
    '期货连续',
    '135000',
    '92000.000',
    '93000.000',
    '87000.000',
    '88000.000',
    '88000.000',
    '88020.000',
    '88000.000',
    '90000.000',
    '92000.000',
    '30',
    '2',
    '400442.000',
    '352317',
    '',
    '品种',
    '2026-10-27'
  ];
  for (const [index, value] of Object.entries(overrides)) fields[index] = value;
  return `var hq_str_nf_${code}="${fields.join(',')}";`;
}

test('期货代码支持数字、品种简称和新浪前缀，不混淆境内外代码', () => {
  assert.deepEqual(normalizeCommodityCodes('lc0, NF_LC,lh,nf_lh0,hf_nq,NQ'), ['LC0', 'LH0', 'NQ']);
  for (const invalid of ['hf_LC0', 'nf_NQ', 'LC2701', 'LH0&list=evil'])
    assert.throws(() => normalizeCommodityCodes(invalid));
  for (const code of ['LC0', 'LH0', 'NQ'])
    assert.equal(commodityUrl(code), `https://finance.sina.com.cn/futures/quotes/${code}.shtml`);
});

test('国内主连按昨结算计算涨跌，正确读取开高低、成交持仓和报价时间', () => {
  const result = parseCommodityQuotes(
    [domesticLine('LC0'), domesticLine('LH0', { 8: '9400.000', 10: '9200.000' }), line('NQ')].join('\n'),
    ['LC0', 'LH0', 'NQ']
  );
  assert.equal(result.errors.size, 0);
  const q = result.quotes.get('LC0');
  assert.equal(q.price, 88000);
  assert.equal(q.priceText, '88000.000');
  assert.equal(q.previousClose, null);
  assert.equal(q.previousSettlement, 92000);
  assert.equal(q.settlement, 90000);
  assert.equal(q.delta, -4000);
  assert.equal(q.percent, (-4000 / 92000) * 100);
  assert.deepEqual([q.open, q.high, q.low, q.volume, q.openInterest], [92000, 93000, 87000, 352317, 400442]);
  assert.equal(q.time, '13:50:00');
  assert.equal(q.timestamp, Date.parse('2026-10-27T13:50:00+08:00') / 1000);
  assert.equal(result.quotes.get('LH0').delta, 200);
  assert.equal(result.quotes.get('NQ').percent, 10.125);
});

test('期货缺昨结不伪造涨跌，零报价、错误时间或接口前缀不覆盖有效行情', () => {
  for (const missing of ['', '0', 'NaN']) {
    const q = parseCommodityQuotes(domesticLine('LC0', { 10: missing }), ['LC0']).quotes.get('LC0');
    assert.equal(q.previousSettlement, null);
    assert.equal(q.delta, null);
    assert.equal(q.percent, null);
  }
  for (const invalid of [
    { 8: '0' },
    { 8: '' },
    { 8: 'Infinity' },
    { 1: '250000' },
    { 1: '13500' },
    { 17: '2026-02-30' },
    { 13: '-1' }
  ]) {
    const r = parseCommodityQuotes([domesticLine('LC0', invalid), line('NQ')].join('\n'), ['LC0', 'NQ']);
    assert.equal(r.errors.has('LC0'), true);
    assert.equal(r.quotes.has('NQ'), true);
  }
  const mismatch = parseCommodityQuotes([line('LC0'), domesticLine('NQ')].join('\n'), ['LC0', 'NQ']);
  assert.equal(mismatch.quotes.size, 0);
  assert.equal(mismatch.errors.size, 2);
});

test('国内期货和CFD混合一次请求，仍仅请求已选品种并分别解析', async () => {
  const calls = [];
  const provider = new CommodityProvider({
    request: async (url) => {
      calls.push(url);
      return Buffer.from([domesticLine('LC0'), domesticLine('LH0'), line('NQ'), line('XAU')].join('\n'));
    }
  });
  const result = await provider.load(['nf_lc0', 'LH0', 'hf_NQ', 'XAU', 'LC0']);
  assert.deepEqual(calls, ['https://hq.sinajs.cn/list=nf_LC0,nf_LH0,hf_NQ,hf_XAU']);
  assert.equal(result.errors.size, 0);
  assert.equal(result.quotes.size, 4);
});
module.exports = { line, domesticLine };
