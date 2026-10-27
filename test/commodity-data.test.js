'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { COMMODITIES, DEFAULT_COMMODITY_CODES, normalizeCommodityCodes, parseCommodityQuotes, CommodityProvider, commodityUrl } = require('../src/commodity-data');
function line(code, overrides = {}) {
  const fields = ['110.125', '', '110.1', '110.2', '111.5', '109.2', '13:50:00', '100', '109.5', '0', '0', '0', '2026-10-27', '来源名称'];
  for (const [index, value] of Object.entries(overrides)) fields[index] = value;
  return `var hq_str_hf_${code}="${fields.join(',')}";`;
}
test('商品默认四项顺序固定，前缀大小写去重，目录有额外候选但不自动选入', () => {
  assert.deepEqual(DEFAULT_COMMODITY_CODES, ['XAU', 'OIL', 'CAD', 'XAG']); assert.equal(COMMODITIES.length, 14);
  assert.deepEqual(normalizeCommodityCodes('hf_xau,oil，CAD;XAU'), ['XAU', 'OIL', 'CAD']);
  assert.deepEqual(normalizeCommodityCodes([]), []);
  for (const value of [null, [7], 'XAU&list=CL', 'USD', ['https://evil.test']]) assert.throws(() => normalizeCommodityCodes(value));
  assert.equal(commodityUrl('XAU'), 'https://finance.sina.com.cn/futures/quotes/XAU.shtml'); assert.throws(() => commodityUrl('../x'));
});
test('按来源昨收计算涨跌、保留三位精度和跨时区时间；非所选商品不混入', () => {
  const result = parseCommodityQuotes([line('OIL'), line('XAU'), line('CAD', { 0: '98.250' })].join('\n'), ['OIL', 'CAD']);
  assert.equal(result.errors.size, 0); assert.equal(result.quotes.size, 2);
  const q = result.quotes.get('OIL'); assert.equal(q.priceText, '110.125'); assert.equal(q.price, 110.125);
  assert.equal(q.percent, 10.125); assert.equal(q.open, 109.5); assert.equal(q.previousClose, 100);
  assert.equal(q.timestamp, Date.parse('2026-10-27T05:50:00Z') / 1000); assert.ok(Math.abs(result.quotes.get('CAD').percent + 1.75) < 1e-10);
});
test('单品种缺失或异常不丢其他报价，不执行响应里的脚本；缺昨收不假报0%', () => {
  const r = parseCommodityQuotes([line('OIL'), 'var hq_str_hf_XAU="";', line('CAD', { 12: '2026-02-30' }), 'throw new Error("must not run");'].join('\n'), DEFAULT_COMMODITY_CODES);
  assert.deepEqual([...r.quotes.keys()], ['OIL']); assert.deepEqual([...r.errors.keys()].sort(), ['CAD', 'XAG', 'XAU']);
  for (const value of ['', '0', 'NaN']) {
    const q = parseCommodityQuotes(line('XAU', { 7: value }), ['XAU']).quotes.get('XAU'); assert.equal(q.percent, null);
  }
  for (const overrides of [{ 0: '' }, { 0: 'Infinity' }, { 6: '24:01:00' }, { 12: '' }]) assert.equal(parseCommodityQuotes(line('XAU', overrides), ['XAU']).errors.size, 1);
  const negative = parseCommodityQuotes(line('OIL', { 0: '-1.000' }), ['OIL']).quotes.get('OIL'); assert.equal(negative.price, -1); assert.equal(negative.percent, -101);
});
test('只请求所选代码且合并为一次请求，空列表不访问网络，取消丢弃迟到结果', async () => {
  const calls = [], abort = new AbortController();
  const provider = new CommodityProvider({ request: async (url, signal, headers) => { calls.push({ url, signal, headers }); return Buffer.from(line('XAU')); } });
  await provider.load([]); assert.equal(calls.length, 0);
  const r = await provider.load(['XAU'], abort.signal); assert.equal(r.quotes.size, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hq.sinajs.cn/list=hf_XAU'); assert.equal(calls[0].headers.Referer, 'https://finance.sina.com.cn/');
  provider.request = async () => { abort.abort(); return Buffer.from(line('XAU')); }; await assert.rejects(provider.load(['XAU'], abort.signal), /取消/);
});
module.exports = { line };
