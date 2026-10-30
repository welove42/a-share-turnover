'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const { harness }=require('./vscode-mock');

function fixture(h) {
  const calls=[], newsTab={input:{uri:{scheme:'a-share-news'}}}, userTab={input:{uri:{scheme:'file'}}};
  h.api.commands={executeCommand:async (...args)=>{calls.push(args);}};
  h.api.window.tabGroups={all:[{tabs:[newsTab,userTab]}],close:async (tabs,preserveFocus)=>{calls.push(['closeTabs',tabs,preserveFocus]);}};
  const obj=(visible=false)=>{ const events=new h.api.EventEmitter(); return {hidden:false,paused:true,tree:{visible,onDidChangeVisibility:events.event,events},setHidden(value,since){this.hidden=value;this.since=since;calls.push(['hidden',value]);}}; };
  const parts={controller:obj(),stocks:obj(true),news:obj(),charts:obj(),globals:obj(),funds:obj(),commodities:obj(),sectors:obj(),reminders:obj()};
  return {parts,calls,newsTab,userTab};
}
test('老板键隐藏所有模块，只关闭插件新闻标签并保留原暂停状态',async()=>{
  const h=harness(), f=fixture(h), {BossKey}=h.load('../src/boss-key');
  const b=new BossKey(h.context,f.parts); await b.toggle();
  assert.equal(b.hidden,true); assert.ok(Object.values(f.parts).every(o=>o.hidden));
  assert.ok(f.calls.some(c=>c[0]==='setContext'&&c[1]==='aShareTurnover.visible'&&c[2]===false));
  assert.ok(!f.calls.some(c=>c[0]==='workbench.view.explorer'));
  assert.deepEqual(f.calls.find(c=>c[0]==='closeTabs')[1],[f.newsTab]);
  assert.equal(h.store.get('bossKeyHidden'),true);
  await b.toggle(); assert.equal(b.hidden,false); assert.ok(Object.values(f.parts).every(o=>!o.hidden && o.paused));
  assert.equal(h.store.get('bossKeyHidden'),false); b.dispose();
});
test('连续快速切换按最终状态持久化；重启后保持隐藏',async()=>{
  const h=harness(), f=fixture(h), {BossKey}=h.load('../src/boss-key'); const b=new BossKey(h.context,f.parts);
  const a=b.toggle(), z=b.toggle(); await Promise.all([a,z]); assert.equal(h.store.get('bossKeyHidden'),false);
  await b.toggle(); b.dispose();
  const f2=fixture(h), restarted=new BossKey(h.context,f2.parts); assert.equal(restarted.hidden,true);
  assert.ok(Object.values(f2.parts).every(o=>o.hidden)); restarted.dispose();
});
test('隐藏时取消尚未完成的选择框，即使恢复后才返回结果也丢弃',async()=>{
  const h=harness(); let resolve, token;
  h.api.window.showQuickPick=(_items,_options,t)=>{token=t;return new Promise(r=>resolve=r);};
  const ui=h.load('../src/privacy-ui');
  const pending=ui.showQuickPick([{label:'股票'}],{}); ui.setHidden(true); assert.equal(token.isCancellationRequested,true);
  ui.setHidden(false); resolve({label:'股票'}); assert.equal(await pending,undefined);
});
test('隐藏时股票请求和自选结果不能重新显示，恢复前暂停状态保留',async()=>{
  const h=harness(); const {WatchlistController}=h.load('../src/watchlist'); let requests=0;
  const stocks=new WatchlistController(h.context,{provider:{load:async()=>{requests++;return {quotes:new Map(),errors:new Map()};}}});
  stocks.paused=true; stocks.publish(true); assert.equal(stocks.status.visible,true);
  stocks.setHidden(true); assert.equal(stocks.status.visible,false); assert.deepEqual(stocks.getChildren(),[]);
  await stocks.refresh(); await stocks.overseas.refreshAll(true); assert.equal(requests,0);
  stocks.setHidden(false); await Promise.resolve(); assert.equal(stocks.paused,true); assert.equal(requests,0); assert.equal(stocks.status.visible,true);
  stocks.dispose();
});
test('隐藏期间跨过的提醒阶段不在恢复时补发',()=>{
  const h=harness({'aShareTurnover.reminders.categories':['nonfarm']}), messages=[];
  h.api.window.showInformationMessage=text=>{messages.push(text);return Promise.resolve();};
  const {ReminderController}=h.load('../src/reminders');
  const c=new ReminderController(h.context,{now:()=>new Date('2026-11-06T13:10:00Z')}); c.enabled=false;
  c.setHidden(true); c.setHidden(false,Date.parse('2026-11-05T12:00:00Z')); c.notifyDue();
  assert.equal(messages.length,0); c.dispose();
});
test('声明的默认快捷键及四个侧栏均受隐藏上下文控制',()=>{
  const p=require('../package.json'), key=p.contributes.keybindings.find(k=>k.command==='welove42.aShareTurnover.toggleHidden');
  assert.equal(key.key,'ctrl+shift+;');
  assert.ok(p.contributes.views.welove42Market.every(v=>v.when?.includes('aShareTurnover.visible')));
  assert.ok(p.contributes.viewsWelcome.every(v=>v.when?.includes('aShareTurnover.visible')));
});
test('隐藏和恢复只更新视图上下文，不拦截点击或强行切换侧栏',async()=>{
  const h=harness(), f=fixture(h), {BossKey}=h.load('../src/boss-key');
  f.parts.stocks.tree.visible=false;
  const b=new BossKey(h.context,f.parts); await b.toggle();
  assert.equal(f.calls.filter(c=>c[0]==='workbench.view.explorer').length,0);
  f.parts.stocks.tree.events.fire({visible:true});
  assert.equal(f.calls.filter(c=>c[0]==='workbench.view.explorer').length,0);
  await b.toggle(); f.parts.stocks.tree.events.fire({visible:true});
  assert.equal(f.calls.filter(c=>c[0]==='workbench.view.explorer').length,0); b.dispose();
});
test('以隐藏状态启动扩展时不显示状态栏或触发行情命令，恢复保留暂停设置',async()=>{
  const h=harness(), commands=new Map(), contexts=[];
  h.store.set('bossKeyHidden',true); h.store.set('bossKeyHiddenSince',Date.now()-1000);
  h.store.set('paused',true); h.store.set('stocksPaused',true); h.store.set('newsPaused',true);
  h.api.commands={registerCommand:(id,handler)=>{commands.set(id,handler);return {dispose(){commands.delete(id);}};},executeCommand:async (...args)=>{contexts.push(args);}};
  h.api.extensions={getExtension:()=>undefined}; h.api.window.showInformationMessage=async()=>undefined;
  h.context.subscriptions=[];
  const {activate}=h.load('../src/extension'); activate(h.context);
  assert.ok(h.statuses.length>=6); assert.ok(h.statuses.every(s=>!s.visible));
  await new Promise(setImmediate);
  assert.ok(contexts.some(c=>c[0]==='setContext' && c[1]==='aShareTurnover.visible' && c[2]===false));
  assert.equal(commands.get('welove42.aShareTurnover.stocks.refresh')(),undefined);
  await commands.get('welove42.aShareTurnover.toggleHidden')();
  assert.equal(h.store.get('paused'),true); assert.equal(h.store.get('stocksPaused'),true); assert.equal(h.store.get('newsPaused'),true);
  assert.ok(h.statuses.some(s=>s.visible));
  for(const item of h.context.subscriptions) item.dispose();
});
