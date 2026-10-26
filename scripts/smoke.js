'use strict';

const { MarketProvider } = require('../src/provider');
const { view } = require('../src/view');
const { session, isSnapshot } = require('../src/market');

(async () => {
  const provider = new MarketProvider({ log: console.error });
  const snapshot = await provider.load(undefined, true);
  if (!isSnapshot(snapshot)) throw new Error('快照格式无效');
  if (!snapshot.sameTime || !snapshot.previousDay) throw new Error(snapshot.warning || '缺少比较数据');
  const result = view(snapshot, {}, { comparisonMode: 'sameTime', showDifferenceAmount: true }, session(new Date()));
  console.log(result.text);
  console.log(JSON.stringify(snapshot, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
