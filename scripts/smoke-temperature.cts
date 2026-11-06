'use strict';
const { MarketProvider } = require('../dist/features/turnover/provider.js');
const { session } = require('../dist/features/turnover/market.js');
const { marketTemperature, temperatureView } = require('../dist/features/temperature/service.js');
(async () => {
  const snapshot = await new MarketProvider().load(),
    now = new Date();
  const result = marketTemperature(snapshot, {}, session(now), now);
  if (!snapshot.markets.every((m) => m.breadth && Number.isFinite(m.percent))) throw new Error('温度数据字段缺失');
  console.log(temperatureView(result).detail);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
