'use strict';
const assert = require('node:assert/strict');
const { FundProvider, holdingReturn } = require('../dist/features/funds/data.js');
(async () => {
  const provider = new FundProvider();
  const search = await provider.search('沪深300');
  assert.ok(search.length);
  console.log(`名称搜索返回${search.length}个候选`);
  const { quotes, errors } = await provider.load(['110020', '000198']);
  assert.equal(errors.size, 0);
  assert.equal(quotes.get('110020').kind, 'nav');
  assert.equal(quotes.get('000198').kind, 'money');
  for (const quote of quotes.values()) console.log(JSON.stringify(quote));
  const estimates = await provider.loadEstimates(['110020', '005827', '000198']);
  assert.equal(estimates.errors.size, 0);
  assert.equal(estimates.estimates.size + estimates.unavailable.size, 3);
  for (const estimate of estimates.estimates.values()) console.log(JSON.stringify({ estimate }));
  console.log('暂无估值：' + [...estimates.unavailable].join('、'));
  // Synthetic position for validating the formula, unrelated to any user holding.
  const returns = holdingReturn(quotes.get('110020'), { shares: 100, cost: 100 });
  assert.ok(returns);
  assert.equal(holdingReturn(quotes.get('000198'), { shares: 100, cost: 100 }), null);
  console.log('已验证正式净值、盘中估值时间、无估值回退及模拟持仓公式。');
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
