'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const { harness }=require('./vscode-mock');
const { parseQuotes }=require('../src/quotes');
const NOW=new Date('2026-10-26T10:30:30+08:00');
function quote(symbol,name='测试股',price='11.30',percent='0.89',timestamp='20261026103030') {
  const q=Array(40).fill('0');q[1]=name;q[2]=symbol.slice(2);q[3]=price;q[4]='11.20';q[30]=timestamp;q[31]='0.10';q[32]=percent;q[33]='11.40';q[34]='11.00';
  return parseQuotes(`v_${symbol}="${q.join('~')}";`,[symbol]).quotes.get(symbol);
}
function setup(extra={},load) {
  const h=harness(extra);let now=NOW,calls=0;
  const {WatchlistController}=h.load('../src/watchlist');
  const c=new WatchlistController(h.context,{now:()=>now,provider:{load:async(...args)=>{calls++;return load?load(...args):{quotes:new Map(args[0].map(s=>[s,quote(s,s==='sh000001'?'上证指数':'测试股')])),errors:new Map()};}}});
  return {...h,c,setNow:d=>{now=new Date(d);},calls:()=>calls};
}
function dragController(h) {
  return h.trees.get('welove42.aShareTurnover.marketWatch').dragAndDropController;
}
function drag(h, symbols) {
  const controller = dragController(h), transfer = new Map();
  controller.handleDrag(symbols.map(s => h.c.element(s)), transfer, { isCancellationRequested: false });
  return transfer;
}

test('拖动向上向下或分组末尾排序，刷新与重启保留顺序且不额外请求行情', async () => {
  const h = setup({'aShareTurnover.stocks.symbols':['sh600519','sz000001','sz300750','sh510300']});
  try {
    await h.c.refresh(); const before = h.calls(), controller = dragController(h), token = { isCancellationRequested: false };
    await controller.handleDrop(h.c.element('sz000001'), drag(h, ['sh510300']), token);
    assert.deepEqual(h.c.config.symbols, ['sh600519','sh510300','sz000001','sz300750']);
    await controller.handleDrop(h.c.element('sz300750'), drag(h, ['sh600519']), token);
    assert.deepEqual(h.c.config.symbols, ['sh510300','sz000001','sz300750','sh600519']);
    await controller.handleDrop(h.c.group, drag(h, ['sz000001']), token);
    assert.deepEqual(h.c.getChildren(h.c.group).map(e => e.symbol), ['sh510300','sz300750','sh600519','sz000001']);
    assert.equal(h.calls(), before); await h.c.refresh();
    assert.deepEqual(h.c.getChildren(h.c.group).map(e => e.symbol), ['sh510300','sz300750','sh600519','sz000001']);
    const { WatchlistController } = h.load('../src/watchlist'); const restored = new WatchlistController(h.context);
    try { assert.deepEqual(restored.config.symbols, h.c.config.symbols); } finally { restored.dispose(); }
  } finally { h.c.dispose(); }
});

test('按涨幅排序时拖动以当前显示顺序为基础并切回手动排序', async () => {
  const h = setup({'aShareTurnover.stocks.symbols':['sh600519','sz000001','sz300750'],'aShareTurnover.stocks.sortBy':'percentDesc'});
  try {
    h.c.quotes.set('sh600519', quote('sh600519','茅台','10','1'));
    h.c.quotes.set('sz000001', quote('sz000001','平安','10','3'));
    h.c.quotes.set('sz300750', quote('sz300750','宁德','10','2'));
    assert.deepEqual(h.c.getChildren(h.c.group).map(e => e.symbol), ['sz000001','sz300750','sh600519']);
    await dragController(h).handleDrop(h.c.element('sz000001'), drag(h, ['sh600519']), { isCancellationRequested: false });
    assert.deepEqual(h.c.config.symbols, ['sh600519','sz000001','sz300750']); assert.equal(h.c.config.sortBy, 'manual');
    h.c.quotes.set('sz000001', quote('sz000001','平安','10','-9')); h.c.publish(false);
    assert.deepEqual(h.c.getChildren(h.c.group).map(e => e.symbol), ['sh600519','sz000001','sz300750']);
    assert.equal(h.values.get('aShareTurnover.stocks.sortBy'), 'manual');
  } finally { h.c.dispose(); }
});

test('设置不可写时拖拽顺序使用持久存储；错误来源、取消和无效目标不修改', async () => {
  const h = setup({'aShareTurnover.stocks.symbols':['sh600519','sz000001','sz300750']}); h.c.paused = true;
  try {
    const original = h.api.workspace.getConfiguration;
    h.api.workspace.getConfiguration = (...args) => ({ ...original(...args), update: async () => { throw new Error('只读'); } });
    const d = dragController(h), valid = drag(h, ['sz300750']), token = { isCancellationRequested: false };
    await d.handleDrop(h.c.element('sh600519'), valid, { isCancellationRequested: true });
    await d.handleDrop(h.c.element('sh600519'), new Map(), token);
    await d.handleDrop(h.c.element('sh600519'), new Map([[d.dropMimeTypes[0], new h.api.DataTransferItem({ owner: {}, symbols:['sz300750'] })]]), token);
    await d.handleDrop({ kind:'stock',symbol:'sh999999' }, valid, token);
    await d.handleDrop(h.c.element('sz300750'), valid, token);
    assert.deepEqual(h.c.config.symbols, ['sh600519','sz000001','sz300750']);
    const group = new Map(); d.handleDrag([h.c.group], group, token); assert.equal(group.size, 0);
    await d.handleDrop(h.c.element('sh600519'), valid, token);
    assert.deepEqual(h.store.get('stockSettingsFallback')['stocks.symbols'], ['sz300750','sh600519','sz000001']);
    const { WatchlistController } = h.load('../src/watchlist'); const restored = new WatchlistController(h.context);
    try { assert.deepEqual(restored.config.symbols, ['sz300750','sh600519','sz000001']); } finally { restored.dispose(); }
  } finally { h.c.dispose(); }
});

test('连续拖拽顺序按操作依次保存，途中添加的股票不会被旧拖拽覆盖', async () => {
  const h = setup({'aShareTurnover.stocks.symbols':['sh600519','sz000001','sz300750']}); h.c.paused = true;
  try {
    const original = h.c.settings.set.bind(h.c.settings); let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    h.c.settings.set = async (key, value) => { if (!release) { await new Promise(resolve => { release = resolve; entered(); }); } return original(key, value); };
    const token = { isCancellationRequested: false }, d = dragController(h);
    const one = d.handleDrop(h.c.element('sh600519'), drag(h, ['sz300750']), token); await started;
    const two = d.handleDrop(h.c.element('sz000001'), drag(h, ['sz300750']), token);
    const added = h.c.add('sh510300');
    release(); await Promise.all([one,two,added]);
    assert.deepEqual(h.c.config.symbols, ['sh600519','sz000001','sz300750','sh510300']);
    await d.handleDrop(h.c.group, drag(h, ['sh600519']), token);
    assert.deepEqual(h.c.config.symbols, ['sz000001','sz300750','sh510300','sh600519']);
  } finally { h.c.dispose(); }
});
test('没有自选时仍获取上证指数并在底部显示',async()=>{
  const h=setup();try{await h.c.refresh();assert.match(h.c.status.text,/上证指数.*11.30.*\+0.89%/);assert.equal(h.c.getChildren().length,3);}finally{h.c.dispose();}
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
    const item=h.c.getTreeItem(rows[0]);assert.match(item.label,/\+0.89%.*11.30.*测试股/);
    assert.equal(item.iconPath.dark,'file:///extension/media/trend-up-dark.svg');
    assert.equal(item.iconPath.light,'file:///extension/media/trend-up-light.svg');
    assert.deepEqual(item.command,{command:'welove42.aShareTurnover.stocks.openChart',title:'查看详细行情图表',arguments:['sh600519']});
    h.c.quotes.set('sz000001',quote('sz000001','下跌股','10.00','-2.00'));
    assert.equal(h.c.getTreeItem(rows[1]).iconPath.dark,'file:///extension/media/trend-down-dark.svg');
    assert.equal(h.c.getTreeItem(rows[1]).iconPath.light,'file:///extension/media/trend-down-light.svg');
    h.c.quotes.set('sz000001',quote('sz000001','平盘股','11.20','0.00'));
    assert.equal(h.c.getTreeItem(rows[1]).iconPath.id,'dash');
    h.c.errors.set('sz000001','请求失败');
    assert.equal(h.c.getTreeItem(rows[1]).iconPath.id,'warning');
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
    assert.equal(picker.items[0].label,'贵州茅台');assert.equal(picker.activeItems[0],picker.items[0]);picker.accept();await done;
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
test('选中个股后点击标题栏加号会打开搜索，确认名称候选后才添加',async()=>{
  const h=setup({'aShareTurnover.stocks.symbols':['sh600105']});h.c.paused=true;
  h.c.search={search:async()=>[{symbol:'sh600519',name:'贵州茅台',pinyin:'gzmt'}]};
  try{
    const done=h.c.add(h.c.element('sh600105'));
    const picker=h.pickers[0];assert.ok(picker,'标题栏传入选中的股票对象时仍应打开搜索框');
    assert.equal(picker.title,'搜索并添加自选股');assert.deepEqual(h.c.config.symbols,['sh600105']);
    picker.change('贵州茅台');await new Promise(r=>setTimeout(r,330));
    assert.equal(picker.items[0].label,'贵州茅台');picker.accept();await done;
    assert.deepEqual(h.c.config.symbols,['sh600105','sh600519']);
  }finally{h.c.dispose();}
});
for(const [label,input] of [
  ['分组行',{kind:'group'}],
  ['视图上下文',{$treeViewId:'welove42.aShareTurnover.marketWatch',$focusedTreeItem:true,$selectedTreeItems:true}],
  ['空上下文',null]
])test(`加号收到${label}时打开搜索，取消不改变自选`,async()=>{
  const h=setup({'aShareTurnover.stocks.symbols':['sh600105']});h.c.paused=true;
  try{
    const done=h.c.add(input);const picker=h.pickers[0];assert.ok(picker);
    picker.hide();await done;assert.deepEqual(h.c.config.symbols,['sh600105']);
    assert.equal(h.store.has('stockSettingsFallback'),false);
  }finally{h.c.dispose();}
});
test('每10秒请求一次，闲置检查不更新底部悬浮或重复触发行刷新',async()=>{
  const h=setup({'aShareTurnover.stocks.symbols':['600519']});
  try{await h.c.refresh();h.c.phaseKey='2026-10-26trading';const writes={...h.c.status.writes},events=h.c.emitter.fired.length;
    h.setNow('2026-10-26T10:30:39+08:00');await h.c.tick();assert.equal(h.calls(),1);assert.deepEqual(h.c.status.writes,writes);assert.equal(h.c.emitter.fired.length,events);
    h.setNow('2026-10-26T10:30:40+08:00');await h.c.tick();assert.equal(h.calls(),2);
  }finally{h.c.dispose();}
});
test('盘前09:15自动开始每10秒刷新，自选行和底部个股同步更新，09:25至09:30继续刷新',async()=>{
  let stamp='20261026091459',price='11.30',percent='0.89';
  const h=setup({'aShareTurnover.stocks.symbols':['sh600105'],'aShareTurnover.stocks.statusBarSymbol':'sh600105'},async symbols=>({quotes:new Map(symbols.map(s=>[s,quote(s,'永鼎股份',price,percent,stamp)])),errors:new Map()}));
  try{
    h.setNow('2026-10-26T09:14:59+08:00');h.c.phaseKey='2026-10-26before';await h.c.refresh();
    stamp='20261026091500';price='11.50';percent='2.68';h.setNow('2026-10-26T09:15:00+08:00');await h.c.tick();assert.equal(h.calls(),2);
    assert.match(h.c.tree.description,/集合竞价.*10秒刷新/);
    assert.match(h.c.getTreeItem(h.c.element('sh600105')).label,/\+2.68%.*11.50/);assert.match(h.c.status.text,/11.50.*\+2.68%/);
    h.setNow('2026-10-26T09:15:09+08:00');await h.c.tick();assert.equal(h.calls(),2);
    stamp='20261026091510';h.setNow('2026-10-26T09:15:10+08:00');await h.c.tick();assert.equal(h.calls(),3);
    stamp='20261026092500';h.setNow('2026-10-26T09:25:00+08:00');await h.c.tick();assert.equal(h.calls(),4);assert.match(h.c.tree.description,/待开盘.*10秒刷新/);
    h.setNow('2026-10-26T09:25:10+08:00');await h.c.tick();assert.equal(h.calls(),5);
    h.setNow('2026-10-26T09:29:59+08:00');await h.c.tick();assert.equal(h.calls(),6);
    stamp='20261026093000';h.setNow('2026-10-26T09:30:00+08:00');await h.c.tick();assert.equal(h.calls(),7);assert.match(h.c.tree.description,/交易中/);
  }finally{h.c.dispose();}
});
test('集合竞价的报价过期按竞价分钟判断，09:25至09:30等待阶段不误报过期',async()=>{
  const h=setup();try{
    h.c.cached=false;h.c.quotes.set('sh000001',quote('sh000001','指数','11.30','0.89','20261026091500'));
    h.setNow('2026-10-26T09:18:00+08:00');assert.equal(h.c.stale('sh000001'),true);
    h.c.quotes.set('sh000001',quote('sh000001','指数','11.30','0.89','20261026092500'));
    h.setNow('2026-10-26T09:29:59+08:00');assert.equal(h.c.stale('sh000001'),false);
    h.setNow('2026-10-26T09:30:00+08:00');assert.equal(h.c.stale('sh000001'),false);
    h.setNow('2026-10-26T09:33:00+08:00');assert.equal(h.c.stale('sh000001'),true);
  }finally{h.c.dispose();}
});
test('盘前失败保留报价并按10秒重试；暂停和禁用时不自动请求',async()=>{
  let fail=false;
  const h=setup({},async symbols=>{if(fail)throw new Error('临时断网');return{quotes:new Map(symbols.map(s=>[s,quote(s,'指数','11.30','0.89','20261026092000')])),errors:new Map()};});
  try{
    h.setNow('2026-10-26T09:20:00+08:00');h.c.phaseKey='2026-10-26auction';await h.c.tick();assert.equal(h.calls(),1);
    fail=true;h.setNow('2026-10-26T09:20:10+08:00');await h.c.tick();assert.equal(h.calls(),2);assert.match(h.c.status.text,/未更新/);assert.ok(h.c.quotes.has('sh000001'));
    fail=false;h.setNow('2026-10-26T09:20:20+08:00');await h.c.tick();assert.equal(h.calls(),3);
    await h.c.togglePause();h.setNow('2026-10-26T09:20:30+08:00');await h.c.tick();assert.equal(h.calls(),3);
    await h.api.workspace.getConfiguration('aShareTurnover').update('stocks.enabled',false);h.c.paused=false;
    h.setNow('2026-10-26T09:25:00+08:00');await h.c.tick();assert.equal(h.calls(),3);
  }finally{h.c.dispose();}
});
test('09:15前、午休、收盘和休市不持续请求，侧栏不再误称10秒刷新',async()=>{
  for(const [stamp,extra] of [
    ['2026-10-26T09:10:00+08:00',{}],['2026-10-26T12:00:00+08:00',{}],['2026-10-26T15:10:00+08:00',{}],
    ['2026-10-24T09:20:00+08:00',{}],['2026-10-01T09:20:00+08:00',{}],
    ['2026-10-26T09:20:00+08:00',{'aShareTurnover.additionalClosedDates':['2026-10-26']}]
  ]){
    const h=setup(extra);try{
      h.setNow(stamp);const c=h.c.clock();h.c.phaseKey=c.date+c.phase;
      await h.c.tick();h.setNow(new Date(new Date(stamp).getTime()+10000));await h.c.tick();
      assert.equal(h.calls(),0,stamp);assert.doesNotMatch(h.c.tree.description,/10秒刷新/);
    }finally{h.c.dispose();}
  }
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
test('标题加号统一搜索港美名称并加入各自分组，已有标记和上下文正确',async()=>{
 const h=setup();h.c.paused=true;h.c.search={searchAll:async query=>query==='腾讯'?[{market:'a',symbol:'sh000847',name:'腾讯济安',pinyin:'txja'},{market:'hk',symbol:'hk00700',name:'腾讯控股',pinyin:'txkg'}]:[{market:'us',symbol:'usAAPL',name:'苹果',pinyin:'pg'}]};
 try{const first=h.c.add(h.c.overseas.groups.us);let picker=h.pickers.at(-1);assert.equal(picker.title,'搜索并添加自选股');picker.change('腾讯');await new Promise(r=>setTimeout(r,330));assert.match(picker.items[1].description,/港股.*hk00700/);picker.selectedItems=[picker.items[1]];picker.accept();await first;assert.deepEqual(h.c.overseas.symbols.hk,['hk00700']);assert.deepEqual(h.c.config.symbols,[]);
 const second=h.c.add();picker=h.pickers.at(-1);picker.change('苹果');await new Promise(r=>setTimeout(r,330));assert.match(picker.items[0].description,/美股.*usAAPL/);picker.accept();await second;assert.deepEqual(h.c.overseas.symbols.us,['usAAPL']);
 const third=h.c.add();picker=h.pickers.at(-1);picker.change('腾讯');await new Promise(r=>setTimeout(r,330));assert.match(picker.items[1].detail,/已在自选/);picker.hide();await third;
 }finally{h.c.dispose();}
});
test('统一入口支持港股代码及美股代码直加，失败时不会误写入A股',async()=>{
 const h=setup();h.c.paused=true;try{
  let pending=h.c.add();let picker=h.pickers.at(-1);picker.change('00700');assert.match(picker.items[0].description,/港股/);picker.accept();await pending;assert.deepEqual(h.c.overseas.symbols.hk,['hk00700']);
  pending=h.c.add();picker=h.pickers.at(-1);picker.change('AAPL');assert.match(picker.items[0].description,/美股/);picker.accept();await pending;assert.deepEqual(h.c.overseas.symbols.us,['usAAPL']);assert.deepEqual(h.c.config.symbols,[]);
 }finally{h.c.dispose();}
});
