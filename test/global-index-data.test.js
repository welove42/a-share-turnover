'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parsePage, GlobalIndexProvider, globalIndexUrl, normalizeIndexIds } = require('../src/global-index-data');
const row = (code, extra = {}) => ({ f12: code, f13: 100, f14: code, f2: 12345.67, f3: -1.25, f4: -150.3, f17: 12400, f18: 12495.97, f15: 12500, f16: 12000, f124: 1793068200, ...extra });
const payload = (rows, total = rows.length) => ({ rc: 0, data: { total, diff: rows } });

test('指数选择代码兼容大小写和完整ID，去重保序，保留显式空列表并拒绝非法输入', () => {
  assert.deepEqual(normalizeIndexIds('ndx, 100.NDX, N225，KS11'), ['100.NDX', '100.N225', '100.KS11']);
  assert.deepEqual(normalizeIndexIds([]), []);
  for (const value of [null, {}, [100], ['https://evil.example'], ['100.NDX?x=1']]) assert.throws(() => normalizeIndexIds(value));
});

test('全球指数点位直接读取小数；区分纳斯达克综合、100及KOSPI200', () => {
  const data = parsePage(payload([row('NDX'), row('NDX100'), row('KS11'), row('KOSPI200'), row('N225')]));
  assert.equal(data.quotes.size, 5); assert.equal(data.quotes.get('100.NDX').price, 12345.67);
  assert.equal(data.quotes.get('100.NDX').percent, -1.25); assert.equal(data.quotes.get('100.NDX').region, 'americas');
  assert.equal(data.quotes.get('100.KS11').region, 'asia');
  assert.equal(data.quotes.get('100.N225').timestamp, 1793068200);
});
test('坏点位单独报错，缺失涨跌幅显示未知而不是0%；损坏接口被拒绝', () => {
  const data = parsePage(payload([row('N225', { f2: '-' }), row('KS11', { f3: '-', f4: '-' }), row('NDX', { f124: null })]));
  assert.equal(data.errors.size, 2); assert.equal(data.quotes.get('100.KS11').percent, null); assert.equal(data.quotes.get('100.KS11').delta, null);
  for (const invalid of [null, { rc: 1, data: {} }, payload([]), payload([row('N225')], 999999)]) assert.throws(() => parsePage(invalid));
  assert.throws(() => parsePage(payload([row('../evil')])), /没有可识别/);
});
test('接口分页完整合并，使用固定数据域名；取消后不返回结果', async () => {
  const calls = [], abort = new AbortController();
  const provider = new GlobalIndexProvider({ request: async (url, signal) => {
    calls.push(url); assert.equal(signal, abort.signal);
    const u = new URL(url); assert.equal(u.host, 'push2.eastmoney.com'); assert.equal(u.searchParams.get('fltt'), '2');
    return payload(u.searchParams.get('pn') === '1' ? [row('N225')] : [row('KS11')], 2);
  } });
  const result = await provider.loadCatalog(abort.signal); assert.equal(result.quotes.size, 2); assert.equal(calls.length, 2);
  const cancelled = new GlobalIndexProvider({ request: async () => { abort.abort(); return payload([row('NDX')]); } });
  await assert.rejects(cancelled.loadCatalog(abort.signal), /取消/);
});
test('接口翻页重复数据不会静默截断；详情链接拒绝任意URL及A股代码', async () => {
  const provider = new GlobalIndexProvider({ request: async () => payload([row('N225')], 2) });
  await assert.rejects(provider.loadCatalog(), /不完整/);
  assert.equal(globalIndexUrl('100.KS11'), 'https://quote.eastmoney.com/gb/zsKS11.html');
  for (const id of ['https://evil.example', '100.NDX?x=1', 'sh000001', '100.../evil']) assert.throws(() => globalIndexUrl(id));
});
