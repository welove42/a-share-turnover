'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const { harness }=require('./vscode-mock');
const { parseQuotes }=require('../src/quotes');
const NOW=new Date('2026-10-26T10:30:30+08:00');
function quote(symbol,name='测试股',price='11.30',percent='0.89') {
  const q=Array(40).fill('0');q[1]=name;q[2]=symbol.slice(2);q[3]=price;q[4]='11.20';q[30]='20261026103030';q[31]='0.10';q[32]=percent;q[33]='11.40';q[34]='11.00';
  return parseQuotes(`v_${symbol}="${q.join('~')}";`,[symbol]).quotes.get(symbol);
}
function setup(extra={},load) {
  const h=harness(extra);let now=NOW,calls=0;
  const {WatchlistController}=h.load('../src/watchlist');
  const c=new WatchlistController(h.context,{now:()=>now,provider:{load:async(...args)=>{calls++;return load?load(...args):{quotes:new Map(args[0].map(s=>[s,quote(s,s==='sh000001'?'上证指数':'测试股')])),errors:new Map()};}}});
  return {...h,c,setNow:d=>{now=new Date(d);},calls:()=>calls};
}
test('没有自选时仍获取上证指数并在底部显示',async()=>{
  const h=setup();try{await h.c.refresh();assert.match(h.c.status.text,/上证指数.*11.30.*\+0.89%/);assert.equal(h.c.getChildren().length,0);}finally{h.c.dispose();}
});
test('通过股票代码批量添加且保存，选择底部个股，删除后恢复上证指数',async()=>{
  const h=setup();try{
    await h.c.add('600519, 000001, sh600519');await new Promise(r=>setImmediate(r));
    assert.deepEqual(h.c.config.symbols,['sh600519','sz000001']);
    await h.c.selectStatus('sz000001');await new Promise(r=>setImmediate(r));
    assert.equal(h.c.config.selected,'sz000001');
    await h.c.remove('sz000001');await new Promise(r=>setImmediate(r));
    assert.equal(h.c.config.selected,'sh000001');assert.deepEqual(h.c.config.symbols,['sh600519']);
  }finally{h.c.dispose();}
});
test('自选行使用稳定对象、名称现价涨跌幅及红绿图标',async()=>{
  const h=setup({'aShareTurnover.stocks.symbols':['600519','000001']});
  try{await h.c.refresh();const group=h.c.getChildren()[0],rows=h.c.getChildren(group);
    assert.equal(h.c.getChildren(group)[0],rows[0]);assert.equal(h.c.getParent(rows[0]),group);
    const item=h.c.getTreeItem(rows[0]);assert.match(item.label,/\+0.89%.*11.30.*测试股/);assert.equal(item.iconPath.color.id,'charts.red');
    assert.deepEqual(item.command,{command:'aShareTurnover.stocks.openChart',title:'查看详细行情图表',arguments:['sh600519']});
    h.c.quotes.set('sz000001',quote('sz000001','下跌股','10.00','-2.00'));
    assert.equal(h.c.getTreeItem(rows[1]).iconPath.color.id,'charts.green');
  }finally{h.c.dispose();}
});

test('旧清单未注册配置或用户设置不可写时，添加选择删除使用持久存储并能重新读取',async()=>{
  const h=setup();h.c.paused=true;
  try{
    const original=h.api.workspace.getConfiguration;
    h.api.workspace.getConfiguration=(...args)=>({...original(...args),update:async()=>{throw new Error('没有注册配置 aShareTurnover.stocks.symbols');}});
    await h.c.add('600519,000001');assert.deepEqual(h.c.config.symbols,['sh600519','sz000001']);
    await h.c.selectStatus('sz000001');assert.equal(h.c.config.selected,'sz000001');
    const {StockSettings}=h.load('../src/stock-settings');const restored=new StockSettings(h.context);
    assert.deepEqual(restored.get('stocks.symbols',[]),['sh600519','sz000001']);
    await h.c.remove('sz000001');assert.equal(h.c.config.selected,'sh000001');assert.deepEqual(h.c.config.symbols,['sh600519']);
    h.api.workspace.getConfiguration=original;
    await h.c.add('300750');assert.deepEqual(h.c.config.symbols,['sh600519','sz300750']);
    assert.equal(Object.hasOwn(h.store.get('stockSettingsFallback'),'stocks.symbols'),false);
  }finally{h.c.dispose();}
});

test('中文名搜索列出候选并添加；新输入取消旧搜索，迟到结果不覆盖',async()=>{
  const h=setup();h.c.paused=true;const requests=[];
  h.c.search={search:(query,signal)=>new Promise(resolve=>requests.push({query,signal,resolve}))};
  try{
    const done=h.c.add();const picker=h.pickers[0];picker.change('平安');
    await new Promise(r=>setTimeout(r,330));assert.equal(requests[0].query,'平安');
    picker.change('茅台');assert.equal(requests[0].signal.aborted,true);
    await new Promise(r=>setTimeout(r,330));
    requests[1].resolve([{symbol:'sh600519',name:'贵州茅台',pinyin:'gzmt'}]);await new Promise(r=>setImmediate(r));
    requests[0].resolve([{symbol:'sz000001',name:'平安银行',pinyin:'payh'}]);await new Promise(r=>setImmediate(r));
    assert.equal(picker.items[0].label,'贵州茅台');picker.selectedItems=[picker.items[0]];picker.accept();await done;
    assert.deepEqual(h.c.config.symbols,['sh600519']);assert.equal(picker.disposed,true);
  }finally{h.c.dispose();}
});

test('搜索不可用时完整代码仍可直接添加；取消窗口不添加任何股票',async()=>{
  const h=setup();h.c.paused=true;
  try{
    const first=h.c.add();let picker=h.pickers[0];picker.change('600519.SH');
    assert.equal(picker.items[0].alwaysShow,true);assert.deepEqual(picker.items[0].symbols,['sh600519']);
    picker.selectedItems=[picker.items[0]];picker.accept();await first;assert.deepEqual(h.c.config.symbols,['sh600519']);
    const second=h.c.add();picker=h.pickers[1];picker.change('平安');picker.hide();await second;assert.deepEqual(h.c.config.symbols,['sh600519']);
  }finally{h.c.dispose();}
});
test('每10秒请求一次，闲置检查不更新底部悬浮或重复触发行刷新',async()=>{
  const h=setup({'aShareTurnover.stocks.symbols':['600519']});
  try{await h.c.refresh();h.c.phaseKey='2026-10-26trading';const writes={...h.c.status.writes},events=h.c.emitter.fired.length;
    h.setNow('2026-10-26T10:30:39+08:00');await h.c.tick();assert.equal(h.calls(),1);assert.deepEqual(h.c.status.writes,writes);assert.equal(h.c.emitter.fired.length,events);
    h.setNow('2026-10-26T10:30:40+08:00');await h.c.tick();assert.equal(h.calls(),2);
  }finally{h.c.dispose();}
});
test('午休不轮询；请求失败保留缓存且不会当作实时',async()=>{
  let fail=false;
  const h=setup({},async symbols=>{if(fail)throw new Error('断网');return{quotes:new Map(symbols.map(s=>[s,quote(s)])),errors:new Map()};});
  try{await h.c.refresh();fail=true;await h.c.refresh();assert.match(h.c.status.text,/未更新/);assert.ok(h.c.quotes.get('sh000001'));
    h.c.phaseKey='2026-10-26lunch';h.setNow('2026-10-26T12:00:00+08:00');await h.c.tick();assert.equal(h.calls(),2);
  }finally{h.c.dispose();}
});
test('进行中的请求合并，暂停会取消，迟到结果不能覆盖',async()=>{
  let resolve,signal;
  const h=setup({},async(symbols,s)=>{signal=s;return new Promise(r=>{resolve=r;});});
  try{const first=h.c.refresh();assert.equal(h.c.refresh(),first);await h.c.togglePause();assert.equal(signal.aborted,true);
    resolve({quotes:new Map([['sh000001',quote('sh000001')]]),errors:new Map()});await first;assert.equal(h.c.quotes.size,0);
  }finally{h.c.dispose();}
});
test('禁用股票模块只隐藏自己的状态栏与树，不影响成交额模块设置',async()=>{
  const h=setup({'aShareTurnover.stocks.symbols':['600519']});
  try{await h.c.refresh();await h.api.workspace.getConfiguration('aShareTurnover').update('stocks.enabled',false);
    assert.equal(h.c.status.visible,false);assert.deepEqual(h.c.getChildren(),[]);assert.equal(h.values.get('aShareTurnover.enabled'),undefined);
  }finally{h.c.dispose();}
});

test('添加代码后立刻刷新会等待已取消的启动请求，最终获取新自选的行情',async()=>{
  let release,calls=0;
  const h=setup({},async(symbols)=>{calls++;if(calls===1)await new Promise(r=>{release=r;});return{quotes:new Map(symbols.map(s=>[s,quote(s)])),errors:new Map()};});
  try{
    const startup=h.c.refresh();await h.c.add('600519');const manual=h.c.refresh();release();await startup;await manual;
    assert.ok(h.c.quotes.has('sh600519'));assert.equal(calls,2);
  }finally{h.c.dispose();}
});
