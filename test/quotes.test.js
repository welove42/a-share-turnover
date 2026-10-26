'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSymbol, normalizeSymbols, parseQuotes, isQuote, StockProvider, orderedSymbols } = require('../src/quotes');
function quoteLine(symbol, { name = '测试股票', price = '11.30', previous = '11.20', percent = '0.89', delta = '0.10', stamp = '20261026103030' } = {}) {
  const q = Array(40).fill('0');
  q[1] = name; q[2] = symbol.slice(2); q[3] = price; q[4] = previous; q[30] = stamp; q[31] = delta; q[32] = percent; q[33] = '11.40'; q[34] = '11.00';
  return `v_${symbol}="${q.join('~')}";`;
}
test('识别六位股票、ETF、北交所、显式指数与代码后缀', () => {
  for (const [input, expected] of [['600519','sh600519'],['000001','sz000001'],['300750','sz300750'],['510300','sh510300'],['159915','sz159915'],['920002','bj920002'],['830799','bj830799'],['SH000001','sh000001'],['600519.SH','sh600519']]) assert.equal(normalizeSymbol(input), expected);
  assert.deepEqual(normalizeSymbols('600519，sh600519 000001;sz159915'), ['sh600519','sz000001','sz159915']);
  for (const code of ['foo', '12345', 'sh600519,sh000001', '600519&token=x', 600519]) assert.throws(() => normalizeSymbol(code));
});
test('批量自选去重，限制100个防止超长请求', () => {
  assert.equal(normalizeSymbols(['600519','600519']).length, 1);
  assert.throws(() => normalizeSymbols(Array.from({length:101},(_,i) => `sh${String(600000+i)}`)), /100/);
});
test('解析名称、涨跌幅、现价及ETF三位小数，不执行返回脚本', () => {
  const text = quoteLine('sh510300',{name:'沪深300ETF',price:'4.179',percent:'-1.89',delta:'-0.051'}) + '\nthrow new Error("never execute")';
  const {quotes,errors} = parseQuotes(text,['sh510300']);
  const q = quotes.get('sh510300');
  assert.equal(q.name,'沪深300ETF'); assert.equal(q.priceText,'4.179'); assert.equal(q.percent,-1.89); assert.equal(q.date,'2026-10-26');
  assert.equal(isQuote(q),true); assert.equal(errors.size,0);
});
test('停牌或暂无成交时不将零价格计算为跌100%', () => {
  const {quotes} = parseQuotes(quoteLine('sz000001',{price:'0.00'}), ['sz000001']);
  const q = quotes.get('sz000001'); assert.equal(q.price,null); assert.equal(q.percent,null); assert.equal(q.priceText,'—');
});
test('无效或缺失股票单独报错，保留其他成功行情', () => {
  const {quotes,errors} = parseQuotes(quoteLine('sh600519') + quoteLine('sz000001',{stamp:'20260230103030'}),['sh600519','sz000001','bj999999']);
  assert.equal(quotes.size,1); assert.equal(errors.size,2);
});
test('涨跌幅排序，缺失值排末，默认保留添加顺序', () => {
  const quotes = new Map([['a',{percent:1}],['b',{percent:-2}],['c',{percent:null}]]);
  assert.deepEqual(orderedSymbols(['a','b','c'],quotes,'percentDesc'),['a','b','c']);
  assert.deepEqual(orderedSymbols(['a','b','c'],quotes,'percentAsc'),['b','a','c']);
  assert.deepEqual(orderedSymbols(['b','a'],quotes,'manual'),['b','a']);
});
test('批量50个一组；单批失败不丢弃另一批结果', async () => {
  let calls=0;
  const provider = new StockProvider(async url => {
    calls++; const symbols=url.split('q=')[1].split(',');
    if(symbols.length===1) throw new Error('断网');
    return symbols.map(s=>quoteLine(s)).join('\n');
  });
  const symbols=Array.from({length:51},(_,i)=>`sh${600000+i}`);
  const result=await provider.load(symbols); assert.equal(calls,2);assert.equal(result.quotes.size,50);assert.equal(result.errors.size,1);
});
module.exports = { quoteLine };
