'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {plain,parseNews,mergeNews,NewsProvider}=require('../src/news-data');
const article=(id,time=1792980000000)=>({key:'eastmoney:'+id,id:String(id),source:'eastmoney',title:'测试快讯 '+id,body:'正文',publishedAt:time,stocks:''});
test('东方财富字段转换北京时间并去重，不执行或渲染接口HTML',()=>{
  const payload={code:'1',data:{fastNewsList:[{code:'202610260001',title:'<b>快讯</b>',summary:'正文 &amp; 内容',showTime:'2026-10-26 10:30:00'}]}};
  const result=parseNews(payload,'eastmoney');assert.equal(result.length,1);assert.equal(result[0].title,'快讯');assert.equal(result[0].body,'正文 & 内容');
  assert.equal(new Date(result[0].publishedAt).toISOString(),'2026-10-26T02:30:00.000Z');assert.equal(plain('<script>x</script>'),'x');
});
test('选股宝沿用参考插件的消息字段及关联股票，授权失败清楚报错',()=>{
  const parsed=parseNews({code:20000,data:{messages:[{id:123,title:'新闻',summary:'摘要',created_at:1792980000,stocks:[{name:'测试股票'}]}]}},'xuangubao');
  assert.equal(parsed[0].source,'xuangubao');assert.equal(parsed[0].stocks,'测试股票');
  assert.throws(()=>parseNews({code:50008,message:'非法token'},'xuangubao'),/Token/);
});
test('错误接口和坏消息不会显示成正常快讯',()=>{
  assert.throws(()=>parseNews({},'eastmoney'));
  assert.deepEqual(parseNews({code:'1',data:{fastNewsList:[{code:'x',title:'新闻',showTime:'bad'}]}},'eastmoney'),[]);
});
test('新闻增量合并按ID去重、更新内容、倒序并限制保留数量',()=>{
  const first=article(1),second=article(2,first.publishedAt+1000);
  const merged=mergeNews([first],[{...first,body:'修订'},second]);
  assert.equal(merged.items[0].id,'2');assert.equal(merged.items[1].body,'修订');assert.equal(merged.added.length,1);
  assert.equal(mergeNews([],Array.from({length:250},(_,i)=>article(i))).items.length,200);
});
test('公开源不传登录凭证；选股宝Token只放在指定域名的请求头',async()=>{
  let captured;
  const p=new NewsProvider(async(url,signal,headers)=>{captured={url,headers};return url.includes('xuangubao')?{code:20000,data:{messages:[]}}:{code:'1',data:{fastNewsList:[]}};});
  await p.load('eastmoney','synthetic-secret');assert.equal(captured.headers['x-ivanka-token'],undefined);
  await p.load('xuangubao','synthetic-secret');assert.equal(new URL(captured.url).hostname,'baoer-api.xuangubao.com.cn');assert.equal(captured.headers['x-ivanka-token'],'synthetic-secret');assert.equal(captured.url.includes('synthetic-secret'),false);
  await assert.rejects(p.load('xuangubao',''),/需要登录/);
});
