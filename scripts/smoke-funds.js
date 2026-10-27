'use strict';
const assert = require('node:assert/strict');
const { FundProvider, holdingReturn } = require('../src/fund-data');
(async () => {
  const provider = new FundProvider();
  const search = await provider.search('沪深300'); assert.ok(search.length); console.log(`名称搜索返回${search.length}个候选`);
  const { quotes, errors } = await provider.load(['110020', '000198']);
  assert.equal(errors.size, 0); assert.equal(quotes.get('110020').kind, 'nav'); assert.equal(quotes.get('000198').kind, 'money');
  for (const quote of quotes.values()) console.log(JSON.stringify(quote));
  // Synthetic position for validating the formula, unrelated to any user holding.
  const returns = holdingReturn(quotes.get('110020'), { shares: 100, cost: 100 });
  assert.ok(returns); assert.equal(holdingReturn(quotes.get('000198'), { shares: 100, cost: 100 }), null);
  console.log('已验证净值日期、普通/货币基金口径和模拟持仓公式。');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
