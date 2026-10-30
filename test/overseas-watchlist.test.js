'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {harness}=require('./vscode-mock');
const {normalizeOverseas,parseOverseasSearch,parseOverseasQuotes,localClock}=harness().load('../src/overseas-watchlist');
function line(symbol, code, time, percent='1.48') { const q=Array(40).fill('0'); q[1]='测试';q[2]=code;q[3]='348.91';q[4]='343.83';q[30]=time;q[31]='5.08';q[32]=percent;q[33]='351.43';q[34]='347.30';return `v_${symbol}="${q.join('~')}";`; }
test('港美股代码和腾讯搜索协议，交易所后缀不会混淆股票代码',()=>{
 assert.equal(normalizeOverseas('700','hk'),'hk00700');assert.equal(normalizeOverseas('AAPL','us'),'usAAPL');assert.equal(normalizeOverseas('usBRK.B','us'),'usBRK.B'); assert.equal(normalizeOverseas('USFD','us'),'usUSFD');
 assert.throws(()=>normalizeOverseas('../bad','us'));const text='v_hint="hk~00700~\\u817e\\u8baf\\u63a7\\u80a1~txkg~GP^us~aapl.oq~\\u82f9\\u679c~pg~GP^hk~13005~\\u8ba4\\u8d2d~rg~QZ"';
 assert.deepEqual(parseOverseasSearch(text,'hk').map(x=>x.symbol),['hk00700']);assert.equal(parseOverseasSearch(text,'us')[0].name,'苹果');
});
test('行情解析保留香港与美东时间，拒绝错码、坏时间和无行情',()=>{
 const h=parseOverseasQuotes(line('hk00700','00700','2026/10/30 11:05:20'),'hk',['hk00700']);assert.equal(h.quotes.get('hk00700').timestamp,'20261030110520');
 const u=parseOverseasQuotes(line('usAAPL','AAPL.OQ','2026-10-29 16:00:01'),'us',['usAAPL']);assert.equal(u.quotes.get('usAAPL').date,'2026-10-29');
 assert.equal(parseOverseasQuotes(line('usAAPL','AAPL.B.N','2026-10-29 16:00:01'),'us',['usAAPL']).quotes.size,0);
 assert.equal(parseOverseasQuotes(line('hk00700','00700','2026/10/30 26:00:00'),'hk',['hk00700']).errors.size,1);
});
test('港美各自按本地交易时段刷新，美股正确处理夏令时及跨日',()=>{
 assert.equal(localClock(new Date('2026-10-30T11:00:00+08:00'),'hk').polling,true);
 assert.equal(localClock(new Date('2026-10-30T12:30:00+08:00'),'hk').polling,false);
 assert.equal(localClock(new Date('2026-10-31T00:00:00+08:00'),'us').polling,true);
 assert.equal(localClock(new Date('2026-11-03T22:15:00+08:00'),'us').polling,false);
 assert.equal(localClock(new Date('2026-11-03T22:35:00+08:00'),'us').polling,true);
});
test('空列表显示三个同级分组，支持添加、删除和组内拖拽',async()=>{
 const h=harness(); const {WatchlistController}=h.load('../src/watchlist'); const c=new WatchlistController(h.context,{provider:{load:async()=>({quotes:new Map(),errors:new Map()})}});c.paused=true;
 try {const groups=c.getChildren(); assert.equal(groups.length,3);assert.match(c.getTreeItem(groups[1]).label,/港股 \(0\)/);assert.match(c.getTreeItem(groups[2]).label,/美股 \(0\)/);
  await c.overseas.mutate('hk',()=>['700','09988']);await c.overseas.mutate('us',()=>['AAPL','TSLA']);assert.deepEqual(c.getChildren(groups[1]).map(e=>e.symbol),['hk00700','hk09988']);
  const transfer=new Map(), d=h.trees.get('welove42.aShareTurnover.marketWatch').dragAndDropController, token={isCancellationRequested:false};
  d.handleDrag([c.overseas.element('usTSLA')],transfer,token);await d.handleDrop(c.overseas.element('usAAPL'),transfer,token);assert.deepEqual(c.overseas.symbols.us,['usTSLA','usAAPL']);
  await d.handleDrop(groups[1],transfer,token);assert.deepEqual(c.overseas.symbols.us,['usTSLA','usAAPL']);
  await c.overseas.remove(c.overseas.element('hk00700')); assert.deepEqual(c.overseas.symbols.hk,['hk09988']);
  const restored=new WatchlistController(h.context);try{assert.deepEqual(restored.overseas.symbols.us,['usTSLA','usAAPL']);}finally{restored.dispose();}
 }finally{c.dispose();}
});
test('港美股请求失败保留缓存，显示原始当地时间并可打开行情页',async()=>{
 const h=harness({'aShareTurnover.stocks.hkSymbols':['hk00700']});const {WatchlistController}=h.load('../src/watchlist');let fail=false,time=new Date('2026-10-30T11:05:30+08:00');
 const c=new WatchlistController(h.context,{now:()=>time,provider:{load:async()=>({quotes:new Map(),errors:new Map()})}});
 c.overseas.request=async()=>{if(fail)throw new Error('断网');return line('hk00700','00700','2026/10/30 11:05:20');};
 try {await c.overseas.refresh('hk');const e=c.overseas.element('hk00700'), item=c.getTreeItem(e);assert.match(item.tooltip.value,/11:05:20（香港时间）/);assert.match(item.tooltip.value,/可能延迟/);assert.equal(item.description,'');
  fail=true;time=new Date(time.getTime()+10000);await c.overseas.refresh('hk');const failed=c.getTreeItem(e);assert.equal(failed.description,'获取失败');assert.match(failed.tooltip.value,/断网/);assert.match(failed.label,/348.91/);
  await c.overseas.open(e);assert.equal(h.opened.at(-1),'https://gu.qq.com/hk00700');
 }finally{c.dispose();}
});
test('分组加号按中文名搜索并添加，取消不会写入',async()=>{
 const h=harness(); const {WatchlistController}=h.load('../src/watchlist'); const c=new WatchlistController(h.context,{provider:{load:async()=>({quotes:new Map(),errors:new Map()})}});c.paused=true;
 c.overseas.request=async()=> 'v_hint="hk~00700~\\u817e\\u8baf\\u63a7\\u80a1~txkg~GP^us~tcehy.ps~\\u817e\\u8baf~tx~GP"';
 try {const pending=c.overseas.add(c.overseas.groups.hk), picker=h.pickers.at(-1);picker.change('腾讯');await new Promise(r=>setTimeout(r,330));assert.equal(picker.items[0].label,'腾讯控股');picker.selectedItems=[picker.items[0]];picker.accept();await pending;assert.deepEqual(c.overseas.symbols.hk,['hk00700']);
 const cancel=c.overseas.add(c.overseas.groups.us);h.pickers.at(-1).hide();await cancel;assert.deepEqual(c.overseas.symbols.us,[]);
 }finally{c.dispose();}
});
test('港美股刷新合并并发请求、按10秒限频并在取消后忽略迟到结果',async()=>{
 const h=harness({'aShareTurnover.stocks.usSymbols':['usAAPL']});const {WatchlistController}=h.load('../src/watchlist');let time=new Date('2026-10-31T00:00:00+08:00'),count=0,resolve;
 const c=new WatchlistController(h.context,{now:()=>time,provider:{load:async()=>({quotes:new Map(),errors:new Map()})}});c.overseas.request=()=>{count++;return new Promise(r=>{resolve=r;});};
 try {const a=c.overseas.refresh('us'),b=c.overseas.refresh('us');assert.equal(count,1);resolve(line('usAAPL','AAPL.OQ','2026-10-30 12:00:00'));await Promise.all([a,b]);
 time=new Date(time.getTime()+9000);c.overseas.tick();assert.equal(count,1);time=new Date(time.getTime()+1000);c.overseas.tick();assert.equal(count,2);
 c.overseas.changed();resolve(line('usAAPL','AAPL.OQ','2026-10-30 12:00:01'));await c.overseas.inflight.us;assert.equal(c.overseas.quotes.get('usAAPL').timestamp,'20261030120000');
 }finally{c.dispose();}
});
