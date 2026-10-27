'use strict';
const assert = require('node:assert/strict');
const { CommodityProvider, COMMODITIES, DEFAULT_COMMODITY_CODES, entryFor } = require('../src/commodity-data');
(async () => {
  const codes = process.argv.includes('--all') ? COMMODITIES.map(entry => entry.code) : DEFAULT_COMMODITY_CODES;
  const result = await new CommodityProvider().load(codes);
  assert.equal(result.errors.size, 0, JSON.stringify([...result.errors])); assert.equal(result.quotes.size, codes.length);
  console.log(JSON.stringify([...result.quotes.values()].map(q => ({ ...entryFor(q.code), ...q })), null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
