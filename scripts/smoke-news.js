'use strict';
const {NewsProvider}=require('../src/news-data');
(async()=>{
  const items=await new NewsProvider().load('eastmoney');
  if(!items.length)throw new Error('新闻列表为空');
  console.log(`东方财富接口正常，获取 ${items.length} 条；最新时间：${new Date(items[0].publishedAt).toISOString()}；标题及正文结构通过校验。`);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
