'use strict';
const {StockProvider}=require('../src/quotes');
(async()=>{
  const result=await new StockProvider().load(['sh000001','sh600519','sz000001','sz300750','sh510300','sz159915','bj920002']);
  if(result.errors.size) throw new Error([...result.errors].map(([s,e])=>s+': '+e).join('; '));
  for(const q of result.quotes.values())console.log(`${q.symbol} ${q.name} ${q.priceText} ${q.percent}% ${q.date} ${q.timestamp.slice(8)}`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
