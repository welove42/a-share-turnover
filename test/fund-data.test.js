'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fundCode, fundCodes, parseFundSearch, parseFundQuote, holdingPosition, holdingReturn, FundProvider, fundUrl } = require('../src/fund-data');
const nav = (extra = {}, data = {}) => ({ ErrCode: 0, Data: { FundType: '001', LSJZList: [{ FSRQ: '2026-10-26', DWJZ: '1.5000', LJJZ: '2.1000', JZZZL: '0.50', ...extra }], ...data } });
const searchRow = code => ({ CATEGORY: 700, CODE: code, NAME: '测试基金A', JP: 'CSJJA', FundBaseInfo: { FTYPE: '混合型' } });
test('基金代码保留前导零并去重，拒绝数字类型、URL和超过50个代码', () => {
  assert.equal(fundCode(' 000001 '), '000001'); assert.deepEqual(fundCodes('000001，110020,000001'), ['000001', '110020']);
  assert.deepEqual(fundCodes([]), []);
  for (const code of [1, '00001', 'https://evil.example', '110020?x=1']) assert.throws(() => fundCode(code));
  assert.throws(() => fundCodes(Array.from({ length: 51 }, (_, i) => String(i).padStart(6, '0'))), /50/);
  assert.equal(fundUrl('110020'), 'https://fund.eastmoney.com/110020.html');
});
test('基金搜索只使用基金条目，忽略高亮HTML和其他品种，名称和代码独立保存', () => {
  const rows = parseFundSearch({ ErrCode: 0, Datas: [searchRow('000001'), { ...searchRow('110020'), CATEGORY: 100 }, { ...searchRow('000002'), NAME: '<script>x</script>' }, searchRow('000001')] });
  assert.equal(rows.length, 1); assert.equal(rows[0].code, '000001'); assert.equal(rows[0].type, '混合型');
  assert.throws(() => parseFundSearch({ ErrCode: 1, Datas: [] }));
});
test('普通基金使用已公布净值和涨跌率，不把累计净值当持仓市值；缺失涨跌保持未知', () => {
  const quote = parseFundQuote('110020', nav(), { name: '测试基金' });
  assert.equal(quote.kind, 'nav'); assert.equal(quote.nav, 1.5); assert.equal(quote.percent, 0.5); assert.equal(quote.cumulativeNav, 2.1);
  assert.equal(parseFundQuote('110020', nav({ JZZZL: '' })).percent, null);
  for (const raw of [nav({ DWJZ: '0' }), nav({ DWJZ: '--' }), nav({ FSRQ: '2026-02-30' }), { ErrCode: 0, Data: { LSJZList: [] } }]) assert.throws(() => parseFundQuote('110020', raw));
});
test('货币基金万份收益和七日年化独立显示，绝不当作净值或累计持仓收益', () => {
  const quote = parseFundQuote('000198', nav({ DWJZ: '0.2174', LJJZ: '0.8410', JZZZL: '0.00' }, { FundType: '005', SYType: '每万份收益' }));
  assert.equal(quote.kind, 'money'); assert.equal(quote.nav, undefined); assert.equal(quote.percent, undefined);
  assert.equal(quote.incomePerUnit, 0.2174); assert.equal(quote.incomeUnit, 10000); assert.equal(quote.sevenDayYield, 0.841);
  assert.equal(holdingReturn(quote, { shares: 10000, cost: 10000 }), null);
  assert.equal(parseFundQuote('000198', nav({}, { FundType: '005', SYType: '每百份收益' })).incomeUnit, 100);
  assert.throws(() => parseFundQuote('000198', nav({}, { FundType: '005', SYType: '未知' })), /特殊收益口径/);
});
test('个人持仓按份额乘单位净值减总成本计算，包含亏损和小数，拒绝零成本及无效数字', () => {
  const quote = parseFundQuote('110020', nav());
  const income = holdingReturn(quote, { shares: '1000', cost: '1200' });
  assert.equal(income.value, 1500); assert.equal(income.profit, 300); assert.equal(income.rate, 25); assert.equal(income.date, '2026-10-26');
  assert.equal(holdingReturn(quote, { shares: 100, cost: 200 }).rate, -25);
  const fractional = holdingReturn(parseFundQuote('110020', nav({ DWJZ: '1.2345' })), { shares: 100.25, cost: 120.6 });
  assert.ok(Math.abs(fractional.profit - 3.158625) < 1e-9);
  for (const position of [{ shares: 1, cost: 0 }, { shares: -1, cost: 1 }, { shares: Infinity, cost: 1 }, { shares: '1e3', cost: 1 }, { shares: 1, cost: '' }]) {
    assert.throws(() => holdingPosition(position)); assert.equal(holdingReturn(quote, position), null);
  }
});
test('基金请求限制并发，单只失败不丢弃其他基金；接口仅接收代码，不含持仓', async () => {
  let active = 0, maximum = 0; const urls = [];
  const provider = new FundProvider({ request: async (url, signal, headers) => {
    urls.push(url); assert.equal(headers.Referer, 'https://fund.eastmoney.com/'); const u = new URL(url);
    if (u.host === 'fundsuggest.eastmoney.com') return { ErrCode: 0, Datas: [searchRow(u.searchParams.get('key'))] };
    assert.equal(u.host, 'api.fund.eastmoney.com'); assert.equal(u.searchParams.has('shares'), false); assert.equal(u.searchParams.has('cost'), false);
    active++; maximum = Math.max(active, maximum); await new Promise(r => setImmediate(r)); active--;
    if (u.searchParams.get('fundCode') === '000003') throw new Error('单只失败');
    return nav();
  } });
  const result = await provider.load(Array.from({ length: 9 }, (_, i) => String(i).padStart(6, '0')));
  assert.equal(result.quotes.size, 8); assert.equal(result.errors.size, 1); assert.ok(maximum <= 4);
  assert.ok(urls.length > 0);
  const abort = new AbortController(); const cancelled = new FundProvider({ request: async () => { abort.abort(); return nav(); } });
  await assert.rejects(cancelled.load(['110020'], abort.signal), /取消/);
});
