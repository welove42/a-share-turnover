'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { GlobalIndexProvider, parseSinaIndices, parseSingleIndex, DEFAULT_INDEX_IDS, SOURCE_COOLDOWN_MS } = require('../src/global-index-data');
const NOW = Date.parse('2026-10-28T09:30:00+08:00');
const fixtures = {
  N225: 'var hq_str_b_NKY="日经225指数,64083.7400,815.37,1.29,2:12 AM,14:12:00,2026-10-28,09:28:45,63738.98,63268.37,64196.68,63660.3,0";',
  KS11: 'var hq_str_b_KOSPI="韩国KOSPI指数,5963.21,324.87,5.76,2:27 AM,14:27:00,2026-10-28,09:28:40,5763.85,5638.34,5968.21,5745.51,0";',
  NDX: 'var hq_str_gb_$ixic="纳斯达克,26477.8107,1.18,2026-10-28 05:30:00,308.4293,26286.306,26540.8139,26219.3134,27722,20690,0,0,0,0,--,0,0,0,0,0,0,0,0,0,,Oct 27 05:16PM EDT,26169.3814";'
};
const text = Object.values(fixtures).join('\n');
const row = code => ({ f12: code, f13: 100, f14: code, f2: 12345.67, f3: 1.25, f4: 150.3, f17: 12000, f18: 12195.37, f15: 12500, f16: 11900, f124: NOW / 1000 });
const payload = rows => ({ rc: 0, data: { total: rows.length, diff: rows } });
test('备用映射只匹配现金指数，使用带日期的源更新时间，不采用旧时钟及无日期int行情', () => {
  const q = parseSinaIndices(text + '\nvar hq_str_int_nasdaq="纳斯达克,1,2,3";', [...DEFAULT_INDEX_IDS, '100.NDX100', '100.KOSPI200']);
  assert.equal(q.size, 3); assert.equal(q.get('100.NDX').price, 26477.8107);
  assert.equal(q.get('100.N225').timestamp, Date.parse('2026-10-28T09:28:45+08:00') / 1000);
  assert.equal(q.get('100.KS11').timestampKind, 'updated'); assert.equal(q.get('100.NDX').source, 'sina');
  for (const bad of [text.replace('日经225指数', '日经225期货'), fixtures.N225.replace('2026-10-28', '2026-02-30'), fixtures.N225.replace('09:28:45', '25:00:00')]) assert.equal(parseSinaIndices(bad, ['100.N225']).size, 0);
});
test('正常刷新仅查询所选代码一次，忽略额外返回项，空列表不访问接口', async () => {
  const calls = []; const provider = new GlobalIndexProvider({ now: () => NOW, request: async url => {
    calls.push(url); const u = new URL(url); assert.equal(u.pathname, '/api/qt/ulist.np/get'); assert.equal(u.searchParams.get('secids'), DEFAULT_INDEX_IDS.join(','));
    return payload(['NDX', 'N225', 'KS11', 'SPX'].map(row));
  }, requestText: async () => { throw new Error('不应调用备用源'); } });
  await provider.load([]); assert.equal(calls.length, 0);
  const r = await provider.load(DEFAULT_INDEX_IDS); assert.equal(calls.length, 1); assert.equal(r.quotes.size, 3); assert.equal(r.errors.size, 0); assert.equal(r.entries.has('100.SPX'), false);
});
test('主接口连接重置后独立备用源补齐三项，5分钟内直接走备用，之后重新探测主源', async () => {
  let now = NOW, east = 0, sina = 0;
  const p = new GlobalIndexProvider({ now: () => now, request: async () => { east++; throw new Error('socket hang up'); }, requestText: async (url, signal, headers) => {
    sina++; assert.equal(headers.Referer, 'https://finance.sina.com.cn/'); assert.match(url, /gb_\$ixic,b_NKY,b_KOSPI/); return text;
  } });
  let r = await p.load(DEFAULT_INDEX_IDS); assert.equal(r.errors.size, 0); assert.equal(r.quotes.size, 3); assert.equal(east, 1);
  now += 10000; r = await p.load(DEFAULT_INDEX_IDS); assert.equal(east, 1); assert.equal(sina, 2); assert.equal(r.errors.size, 0);
  now = NOW + SOURCE_COOLDOWN_MS; await p.load(DEFAULT_INDEX_IDS); assert.equal(east, 2); assert.equal(sina, 3);
});
test('主源部分成功只为缺失项补查，不让单一指数失败拖垮其余指数', async () => {
  const calls = []; const p = new GlobalIndexProvider({ now: () => NOW, request: async url => {
    calls.push(url); if (url.includes('/ulist.')) return payload([row('NDX'), row('KS11')]); throw new Error('逐项也失败');
  }, requestText: async url => { assert.match(url, /list=b_NKY$/); return ''; } });
  const r = await p.load(DEFAULT_INDEX_IDS); assert.equal(r.quotes.size, 2); assert.deepEqual([...r.errors.keys()], ['100.N225']); assert.equal(calls.length, 2);
});
test('无独立备用映射的指数使用逐项接口，正确缩放价格和百分比且验证代码', async () => {
  const data = { rc: 0, data: { f43: 6412607, f44: 6419668, f45: 6366030, f46: 6373898, f57: 'NDX100', f58: '纳斯达克100', f59: 2, f60: 6326837, f86: NOW / 1000, f169: 85770, f170: 136 } };
  const q = parseSingleIndex('100.NDX100', data); assert.equal(q.price, 64126.07); assert.equal(q.percent, 1.36); assert.equal(q.delta, 857.7);
  assert.throws(() => parseSingleIndex('100.NDX', data));
  const p = new GlobalIndexProvider({ now: () => NOW, request: async url => { if (url.includes('/ulist.')) throw new Error('down'); return data; }, requestText: async () => { throw new Error('不应给NDX100使用综合指数替代'); } });
  const r = await p.load(['100.NDX100']); assert.equal(r.quotes.size, 1); assert.equal(r.errors.size, 0);
});
test('取消旧请求不触发备用请求，来源未来时间不能作为成功行情返回', async () => {
  let calls = 0; const abort = new AbortController();
  const p = new GlobalIndexProvider({ now: () => NOW, request: async () => { abort.abort(); throw new Error('network'); }, requestText: async () => { calls++; return text; } });
  await assert.rejects(p.load(DEFAULT_INDEX_IDS, abort.signal), /取消/); assert.equal(calls, 0);
  const future = new GlobalIndexProvider({ now: () => NOW, request: async () => { throw new Error('down'); }, requestText: async () => text.replaceAll('2026-10-28', '2027-01-01') });
  const r = await future.load(DEFAULT_INDEX_IDS); assert.equal(r.quotes.size, 0); assert.equal(r.errors.size, 3);
});
test('备用和逐项接口全失败会返回逐项原因，逐项请求60秒冷却避免每次连击', async () => {
  let east = 0, now = NOW;
  const p = new GlobalIndexProvider({ now: () => now, request: async () => { east++; throw new Error('ECONNRESET'); }, requestText: async () => { throw new Error('HTTP 503'); } });
  const first = await p.load(DEFAULT_INDEX_IDS); assert.equal(east, 4); assert.equal(first.errors.size, 3); assert.match(first.errors.get('100.NDX'), /HTTP 503.*ECONNRESET/);
  now += 20000; await p.load(DEFAULT_INDEX_IDS); assert.equal(east, 4);
  now += 40000; await p.load(DEFAULT_INDEX_IDS); assert.equal(east, 7);
});
