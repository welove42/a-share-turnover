'use strict';
const { MarketProvider } = require('../src/provider');
const { session } = require('../src/market');
const { marketTemperature, temperatureView } = require('../src/temperature');
(async () => {
  const snapshot = await new MarketProvider().load(), now = new Date();
  const result = marketTemperature(snapshot, {}, session(now), now);
  if (!snapshot.markets.every(m => m.breadth && Number.isFinite(m.percent))) throw new Error('温度数据字段缺失');
  console.log(temperatureView(result).detail);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
