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
  assert.ok(f.calls.some(c=>c[0]==='setContext'&&c[1]==='aShareTurnover.hidden'&&c[2]===true));
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
test('首次安装默认显示行情，只有主动开启后才进入隐藏模式',async()=>{
  const h=harness(), f=fixture(h), {BossKey}=h.load('../src/boss-key');
  const b=new BossKey(h.context,f.parts); await new Promise(setImmediate);
  assert.equal(b.hidden,false);
  assert.ok(f.calls.some(c=>c[0]==='setContext'&&c[1]==='aShareTurnover.hidden'&&c[2]===false));
  assert.ok(Object.values(f.parts).every(o=>!o.hidden));
  await b.toggle(); assert.equal(b.hidden,true); b.dispose();
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
  stocks.setHidden(true); assert.equal(stocks.status.visible,false);
  const placeholders=stocks.getChildren().map(item=>stocks.getTreeItem(item));
  assert.deepEqual(placeholders.map(item=>item.label),['运行和调试可帮助你发现和修复问题。','运行和调试','创建调试配置']);
  assert.ok(placeholders.slice(1).every(item=>item.command===undefined));
  assert.doesNotMatch(JSON.stringify(placeholders),/股票|行情|新闻|基金|成交/);
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
test('老板键的入口使用中性名称，隐藏时展示调试引导而非行情提示',()=>{
  const p=require('../package.json'), key=p.contributes.keybindings.find(k=>k.command==='welove42.aShareTurnover.toggleHidden');
  assert.equal(key.key,'ctrl+shift+;');
  assert.equal(p.contributes.viewsContainers.activitybar[0].title,'工作台');
  assert.equal(p.contributes.viewsContainers.activitybar[0].icon,'media/market.svg');
  assert.ok(p.contributes.views.welove42Workspace.slice(0,4).every(v=>v.when?.includes('!aShareTurnover.hidden')));
  assert.ok(p.contributes.viewsWelcome.every(v=>v.when?.includes('!aShareTurnover.hidden')));
  const disguise=p.contributes.views.welove42Workspace.find(v=>v.id==='welove42.aShareTurnover.debugCover');
  assert.equal(disguise.type,'webview'); assert.equal(disguise.when,'aShareTurnover.hidden');
  assert.ok(p.contributes.menus['view/title'].filter(v=>v.when.includes('view == welove42.aShareTurnover.')).every(v=>v.when.startsWith('!aShareTurnover.hidden &&')));
});
test('隐藏时四个栏目清除标题中的行情信息、描述和错误，恢复后回到原名称',()=>{
  const h=harness(), classes=[['../src/watchlist','WatchlistController','运行和调试','自选股（名称 / 代码）'],['../src/global-indices','GlobalIndicesController','监视','全球指数'],['../src/funds','FundsController','调用堆栈','基金'],['../src/commodities','CommoditiesController','断点','全球商品']];
  for(const [path,name,hiddenTitle,normalTitle] of classes){
    const C=h.load(path)[name], controller=new C(h.context); controller.paused=true;
    controller.tree.message='行情错误'; controller.tree.description='股票行情'; controller.setHidden(true);
    assert.equal(controller.tree.title,hiddenTitle); assert.equal(controller.tree.message,undefined); assert.equal(controller.tree.description,undefined);
    if (name==='WatchlistController') assert.ok(controller.getChildren().every(item=>item.kind==='debugPlaceholder'));
    else assert.deepEqual(controller.getChildren(),[]);
    controller.setHidden(false); assert.equal(controller.tree.title,normalTitle); controller.dispose();
  }
});
test('自选禁用时，隐藏视图仍提供调试入口，旧股票节点不会泄露行情',()=>{
  const h=harness({'aShareTurnover.stocks.enabled':false}), {WatchlistController}=h.load('../src/watchlist');
  const stocks=new WatchlistController(h.context); stocks.paused=true; stocks.setHidden(true);
  assert.equal(stocks.getChildren().length,3);
  assert.equal(stocks.getTreeItem({kind:'stock',symbol:'sh600519'}).label,'');
  assert.equal(stocks.tree.showCollapseAll,false); stocks.setHidden(false);
  assert.deepEqual(stocks.getChildren(),[]); assert.equal(stocks.tree.showCollapseAll,true); stocks.dispose();
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
  const provider=h.trees.get('welove42.aShareTurnover.marketWatch').treeDataProvider;
  assert.ok(h.webviewViews.has('welove42.aShareTurnover.debugCover'));
  assert.deepEqual(provider.getChildren().map(item=>provider.getTreeItem(item).label),['运行和调试可帮助你发现和修复问题。','运行和调试','创建调试配置']);
  await new Promise(setImmediate);
  assert.ok(contexts.some(c=>c[0]==='setContext' && c[1]==='aShareTurnover.hidden' && c[2]===true));
  assert.equal(commands.get('welove42.aShareTurnover.stocks.refresh')(),undefined);
  await commands.get('welove42.aShareTurnover.toggleHidden')();
  assert.equal(h.store.get('paused'),true); assert.equal(h.store.get('stocksPaused'),true); assert.equal(h.store.get('newsPaused'),true);
  assert.ok(h.statuses.some(s=>s.visible));
  for(const item of h.context.subscriptions) item.dispose();
});
