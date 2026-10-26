'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./vscode-mock');
const NOW=new Date('2026-10-26T10:30:30+08:00');
const article=(id,time=1792980000000)=>({key:'eastmoney:'+id,id:String(id),source:'eastmoney',title:'测试快讯 '+id,body:'测试全文',publishedAt:time,stocks:''});
function setup(extra={},load) {
  const h=harness(extra);let now=NOW,calls=0;
  const {NewsController,TOKEN_KEY}=h.load('../src/news');
  const c=new NewsController(h.context,{now:()=>now,provider:{load:async(...args)=>{calls++;return load?load(...args):[article(1)];}}});
  return {...h,c,TOKEN_KEY,calls:()=>calls,setNow:d=>{now=new Date(d);}};
}
test('首次读取不算未读；重复刷新不重复追加输出，新文章增加未读',async()=>{
  let batch=[article(1)];const h=setup({},async()=>batch);
  try{await h.c.refresh();assert.equal(h.c.items.length,1);assert.equal(h.c.unread,0);assert.equal(h.c.output.lines.length,1);
    await h.c.refresh();assert.equal(h.c.output.lines.length,1);
    batch=[article(2,NOW.getTime()+1000),article(1)];await h.c.refresh();assert.equal(h.c.unread,1);assert.match(h.c.status.text,/\(1\)/);assert.equal(h.c.output.lines.length,2);
    h.c.show();assert.equal(h.c.unread,0);
  }finally{h.c.dispose();}
});
test('点击新闻在只读虚拟文档展示全文，不生成需要保存的临时文件',async()=>{
  const h=setup();try{await h.c.refresh();await h.c.open(h.c.items[0]);const uri=h.opened[0];assert.equal(uri.scheme,'a-share-news');assert.match(h.documents.get(uri.scheme).provideTextDocumentContent(uri),/测试全文/);assert.equal(h.trees.has('aShareTurnover.news'),false);}finally{h.c.dispose();}
});
test('网络失败保留上次新闻，后续刷新可自动恢复',async()=>{
  let fail=false;const h=setup({},async()=>{if(fail)throw new Error('网络断开');return[article(1)];});
  try{await h.c.refresh();fail=true;await h.c.refresh();assert.equal(h.c.items.length,1);assert.match(h.c.output.lines.at(-1),/保留上次/);fail=false;await h.c.refresh();assert.equal(h.c.error,'');}finally{h.c.dispose();}
});
test('取消中的请求不会写入新闻，重复刷新请求会合并',async()=>{
  let resolve,signal;const h=setup({},async(s,t,a)=>{signal=a;return new Promise(r=>{resolve=r;});});
  try{const first=h.c.refresh();assert.equal(h.c.refresh(),first);await h.c.togglePause();assert.equal(signal.aborted,true);resolve([article(1)]);await first;assert.equal(h.c.items.length,0);}finally{h.c.dispose();}
});
test('选股宝凭证保存在SecretStorage，不写入用户设置',async()=>{
  const h=setup();try{h.api.window.showInputBox=async()=> 'synthetic-token';await h.c.setToken();assert.equal(h.secrets.get(h.TOKEN_KEY),'synthetic-token');assert.equal([...h.values.values()].includes('synthetic-token'),false);}finally{h.c.dispose();}
});
test('配置切换新闻源时清除旧源内容，避免混淆来源',async()=>{
  const h=setup({},async source=>source==='eastmoney'?[article(1)]:[]);
  try{await h.c.refresh();await h.api.workspace.getConfiguration('aShareTurnover').update('news.source','xuangubao');await new Promise(r=>setImmediate(r));assert.equal(h.c.config.source,'xuangubao');assert.equal(h.c.items.length,0);}finally{h.c.dispose();}
});
test('新闻只使用底部输出，包含全文和时间；无变化不重写悬浮，主动打开清除未读',async()=>{
  const h=setup();try{await h.c.refresh();const writes={...h.c.status.writes};h.c.publish();h.c.publish();assert.deepEqual(h.c.status.writes,writes);assert.equal(h.c.output.name,'财经新闻7×24资讯');assert.match(h.c.output.lines[0],/📣.*\n📄 摘要：测试全文\n🕒 时间：/);assert.equal(h.trees.size,0);h.c.unread=2;h.c.show();assert.equal(h.c.unread,0);assert.equal(h.c.output.shown,1);}finally{h.c.dispose();}
});
