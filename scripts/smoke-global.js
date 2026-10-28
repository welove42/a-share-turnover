'use strict';
const assert = require('node:assert/strict');
const { GlobalIndexProvider, DEFAULT_INDEX_IDS, globalIndexUrl } = require('../src/global-index-data');
const { shanghaiClock } = require('../src/market');
(async () => {
  const provider = new GlobalIndexProvider();
  const rounds = process.argv.includes('--repeat') ? 3 : 1;
  for (let round = 0; round < rounds; round++) {
    if (round) await new Promise(resolve => setTimeout(resolve, 10000));
    const result = await provider.load(DEFAULT_INDEX_IDS, new AbortController().signal);
    assert.equal(result.errors.size, 0, JSON.stringify([...result.errors]));
    for (const id of DEFAULT_INDEX_IDS) {
      const q = result.quotes.get(id); assert.ok(q, `${id} 行情缺失`);
      const clock = shanghaiClock(new Date(q.timestamp * 1000));
      console.log(`${round + 1} ${q.name} ${q.code} ${q.price.toFixed(2)} ${q.percent}% ${clock.date} ${clock.time}（北京） ${q.source} ${q.timestampKind} ${globalIndexUrl(id)}`);
    }
    console.log(`全球指数：仅请求${DEFAULT_INDEX_IDS.length}个已选项，${result.quotes.size}个有效行情，${result.errors.size}个异常。`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
