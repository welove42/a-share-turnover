'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {plain,parseNews,mergeNews,NewsProvider}=require('../src/news-data');
const article=(id,time=1792980000000)=>({key:'eastmoney:'+id,id:String(id),source:'eastmoney',title:'测试快讯 '+id,body:'正文',publishedAt:time,stocks:''});
test('东方财富字段转换北京时间并去重，不执行或渲染接口HTML',()=>{
  const payload={code:'1',data:{fastNewsList:[{code:'202610260001',title:'<b>快讯</b>',summary:'正文 &amp; 内容',showTime:'2026-10-26 10:30:00'}]}};
  const result=parseNews(payload);assert.equal(result.length,1);assert.equal(result[0].title,'快讯');assert.equal(result[0].body,'正文 & 内容');
  assert.equal(new Date(result[0].publishedAt).toISOString(),'2026-10-26T02:30:00.000Z');assert.equal(plain('<script>x</script>'),'x');
});
test('旧来源文章不混入东方财富快讯',()=>{
  const retired={...article(1),key:'xuangubao:1',source:'xuangubao'};
  assert.deepEqual(mergeNews([retired],[retired,article(2)]).items,[article(2)]);
});
test('错误接口和坏消息不会显示成正常快讯',()=>{
  assert.throws(()=>parseNews({}));
  assert.deepEqual(parseNews({code:'1',data:{fastNewsList:[{code:'x',title:'新闻',showTime:'bad'}]}}),[]);
});
test('新闻增量合并按ID去重、更新内容、倒序并限制保留数量',()=>{
  const first=article(1),second=article(2,first.publishedAt+1000);
  const merged=mergeNews([first],[{...first,body:'修订'},second]);
  assert.equal(merged.items[0].id,'2');assert.equal(merged.items[1].body,'修订');assert.equal(merged.added.length,1);
  assert.equal(mergeNews([],Array.from({length:250},(_,i)=>article(i))).items.length,200);
});
test('新闻只请求东方财富公开接口，不传凭证且保留请求取消能力',async()=>{
  let captured;
  const p=new NewsProvider(async(url,signal,headers)=>{captured={url,signal,headers};return {code:'1',data:{fastNewsList:[]}};});
  const controller=new AbortController();await p.load(controller.signal);
  assert.equal(new URL(captured.url).hostname,'np-listapi.eastmoney.com');assert.deepEqual(captured.headers,{Referer:'https://finance.eastmoney.com/'});assert.equal(captured.signal,controller.signal);
  controller.abort();await assert.rejects(p.load(controller.signal),/已取消/);
});
