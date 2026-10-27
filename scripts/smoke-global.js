'use strict';
const assert = require('node:assert/strict');
const { GlobalIndexProvider, globalIndexUrl } = require('../src/global-index-data');
const { shanghaiClock } = require('../src/market');
(async () => {
  const result = await new GlobalIndexProvider().load(new AbortController().signal);
  for (const id of ['100.N225', '100.KS11', '100.NDX', '100.NDX100', '100.DJIA', '100.SPX']) {
    const q = result.quotes.get(id); assert.ok(q, `${id} 行情缺失`);
    const clock = shanghaiClock(new Date(q.timestamp * 1000));
    console.log(`${q.name} ${q.code} ${q.price.toFixed(2)} ${q.percent}% ${clock.date} ${clock.time}（北京） ${globalIndexUrl(id)}`);
  }
  console.log(`全球指数：${result.entries.size} 个目录项，${result.quotes.size} 个有效行情，${result.errors.size} 个异常。`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
