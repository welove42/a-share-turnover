'use strict';
const { ChartProvider, eastmoneyUrl } = require('../src/chart-data');
const { StockSearch } = require('../src/stock-search');
(async () => {
  const provider = new ChartProvider();
  for (const symbol of ['sh600519', 'sz000001', 'sh000001', 'sh510300', 'bj920002']) {
    for (const mode of ['intraday', 'daily', 'weekly', 'monthly']) {
      const data = await provider.load(symbol, mode);
      console.log(`${symbol} ${data.name} ${mode} ${data.date} ${data.bars.length} points ${data.adjustment} last=${data.bars.at(-1).close} ${eastmoneyUrl(symbol)}`);
    }
  }
  for (const query of ['永鼎股份', '贵州茅台', '平安', 'gzmt', '600519', '510300']) {
    const result = await new StockSearch().search(query);
    if (!result.length) throw new Error(`${query} 搜索为空`);
    console.log(query, result.map(r => `${r.name} ${r.symbol}`).join(' | '));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
