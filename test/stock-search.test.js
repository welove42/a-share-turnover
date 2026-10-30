'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseSuggestions, StockSearch } = require('../src/stock-search');
test('搜索文本中的Unicode名称正确解码，保留前导零，去重且排除港美股', () => {
  const result = parseSuggestions('v_hint="sz~000001~\\u5e73\\u5b89\\u94f6\\u884c~payh~GP-A^sz~000001~重复~payh~GP-A^hk~01833~平安好医生~pa~GP^sh~510300~沪深300ETF~hs~ETF"');
  assert.deepEqual(result.map(r => [r.symbol, r.name]), [['sz000001', '平安银行'], ['sh510300', '沪深300ETF']]);
  assert.deepEqual(parseSuggestions('v_hint=""'), []); assert.throws(() => parseSuggestions('<html>error</html>'), /异常/);
});
test('中文、拼音、代码搜索使用URL编码，不执行JSONP，取消后拒绝结果', async () => {
  let seen;
  const provider = new StockSearch(async (url, signal) => { seen = { url, signal }; return 'v_hint="sh~600519~贵州茅台~gzmt~GP-A"'; });
  const abort = new AbortController(); assert.equal((await provider.search('贵州茅台', abort.signal))[0].symbol, 'sh600519');
  assert.match(seen.url, /q=%E8%B4%B5/); assert.equal(seen.signal, abort.signal);
  abort.abort(); await assert.rejects(provider.search('贵州茅台', abort.signal), /取消/);
});
test('统一搜索保留A股、港股、美股，同名候选带市场且过滤权证',async()=>{
 const {parseMarketSuggestions}=require('../src/stock-search');
 const raw='v_hint="sh~000847~腾讯济安~tx~ZS^hk~00700~\\u817e\\u8baf\\u63a7\\u80a1~txkg~GP^us~tcehy.ps~腾讯控股~txkg~GP^hk~13005~认购~rg~QZ"';
 const result=parseMarketSuggestions(raw);assert.deepEqual(result.map(x=>[x.market,x.symbol,x.name]),[['a','sh000847','腾讯济安'],['hk','hk00700','腾讯控股'],['us','usTCEHY','腾讯控股']]);
 let count=0;const p=new StockSearch(async()=>{count++;return raw;});assert.equal((await p.searchAll('腾讯')).length,3);assert.equal(count,1);
});
