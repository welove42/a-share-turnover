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
