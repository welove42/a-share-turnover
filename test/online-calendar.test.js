'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {parseHolidays,parseTradingDays,makeTradingEvents,parseEconomic,parseUsEarly,ranges,OnlineCalendar}=require('../src/online-calendar');
const {harness}=require('./vscode-mock');
const {shift}=require('../src/event-calendar');
function holidays(market,year) {
  return JSON.stringify({market_id:market,year,coverage:'loaded',review_state:'verified',data_version:'2026.10.22-rc.1',holidays:['01-01','05-01','10-01'].map((d,i)=>({zh:['元旦','劳动节','国庆'][i],start:`${year}-${d}`,end:`${year}-${d}`,record:{market_id:market,status:'closed',is_trading_day:false,review_state:'verified',source_checked_at:'2026-10-22'}}))});
}
function days(year) {
  let d=`${year}-01-01`,end=`${year}-12-31`, rows=[];
  while(d<=end) {let weekend=[0,6].includes(new Date(d+'T00:00:00Z').getUTCDay()),sse=weekend||d===`${year}-11-20`?'closed':'open',hk=d===`${year}-12-24`?'half_day':weekend?'closed':'open';
    rows.push({date:d,markets:{SSE:{status:sse,is_trading_day:sse!=='closed'},HKEX:{status:hk,is_trading_day:hk!=='closed'}}}); d=shift(d,1); }
  return JSON.stringify({start:`${year}-01-01`,end,data_version:'2026.10.22-rc.1',days:rows});
}
function economic(from,to) {
  const rows=[['us-nfp','2026-11-06','2026-11-06T13:30:00+00:00'],['us-nfp','2026-12-04','2026-12-04T13:30:00+00:00'],['us-cpi','2026-11-10','2026-11-10T13:30:00+00:00'],['fomc','2026-12-09','2026-12-09T19:00:00+00:00']].filter(r=>r[1]>=from&&r[1]<=to).map(([series_code,date,release_at_utc])=>({series_code,date,release_at_utc,country:'US',status:'confirmed',data_stale:false,time_precision:'minute'}));
  return JSON.stringify({from,to,count:rows.length,total:rows.length,events:rows});
}
function early(from,to) {
  const rows=[{exchange:'nyse',holiday_status:'early_close',date:'2026-11-27',close_time_local:'13:00',data_stale:false}].filter(r=>r.date>=from&&r.date<=to);
  return JSON.stringify({from,to,count:rows.length,total:rows.length,events:rows});
}
test('已核实的年度休市和半日市、交割日按接口日历生成',()=>{
  assert.equal(parseHolidays(holidays('HKEX',2026),'HKEX',2026).events.length,3);
  const parsed=parseTradingDays(days(2026),2026), e=makeTradingEvents(parsed,2026);
  assert.ok(e.half.some(x=>x.date==='2026-12-24'));
  assert.ok(e.deliveries.some(x=>x.date==='2026-11-23'));
  const incomplete=JSON.parse(days(2026)); incomplete.days[5].markets.HKEX.status='unknown';
  assert.throws(()=>parseTradingDays(JSON.stringify(incomplete),2026));
  const unknown=JSON.parse(holidays('SSE',2026)); unknown.coverage='not_loaded'; unknown.holidays=[];
  assert.throws(()=>parseHolidays(JSON.stringify(unknown),'SSE',2026));
});
test('财经数据仅接受准确时间、完整窗口及 NYSE 提前收盘',()=>{
  const from='2026-10-01',to='2026-12-29', parsed=parseEconomic(economic(from,to),from,to);
  assert.equal(parsed.nonfarm[0].when,Date.parse('2026-11-06T13:30:00Z'));
  assert.equal(parseUsEarly(early(from,to),from,to)[0].time,'13:00');
  const broken=JSON.parse(economic(from,to)); broken.total=9; assert.throws(()=>parseEconomic(JSON.stringify(broken),from,to));
  broken.total=broken.count; broken.events[0].data_stale=true; assert.throws(()=>parseEconomic(JSON.stringify(broken),from,to));
  broken.events[0].data_stale=false; broken.events[0].status='cancelled'; assert.equal(parseEconomic(JSON.stringify(broken),from,to).nonfarm[0].cancelled,true);
});
test('在线、缓存和内置按类型与年份回退，更新失败不抹去可用结果',async()=>{
  const h=harness(); h.api.window.showInformationMessage=async()=>{};
  const {ReminderController}=h.load('../src/reminders'); let fail=false;
  const online=new OnlineCalendar(async url=>{
    if(fail) throw new Error('离线'); const u=new URL(url), y=Number(u.searchParams.get('year'));
    if(url.includes('/holidays?')) { if(y===2027) throw new Error('未来年份未覆盖'); return holidays(u.pathname.split('/')[4],y); }
    if(url.includes('/trading-days?')) {const year=Number(u.searchParams.get('start').slice(0,4)); if(year===2027) throw new Error('未来年份未覆盖'); return days(year);}
    const from=u.searchParams.get('from'),to=u.searchParams.get('to'); return u.searchParams.has('series')?economic(from,to):early(from,to);
  });
  const now=()=>new Date('2026-10-30T06:00:00Z');
  const c=new ReminderController(h.context,{online,now,provider:{fetch:async()=>{throw new Error('离线');}}}); await c.refresh();
  let all=c.events();
  assert.ok(all.some(x=>x.type==='cpi' && x.date==='2026-11-10' && /Finance Calendar.*接口/.test(x.provenance)));
  assert.ok(all.some(x=>x.type==='nonfarm' && x.date==='2026-12-04' && /Finance Calendar/.test(x.provenance)), JSON.stringify(all.filter(x=>x.type==='nonfarm').slice(0,5)));
  assert.ok(all.some(x=>x.name==='港股半日市' && x.date==='2026-12-24' && /Markets Open.*接口/.test(x.provenance)));
  assert.ok(all.some(x=>x.type==='delivery' && x.date==='2026-11-23' && /推算/.test(x.provenance)));
  assert.ok(all.some(x=>x.type==='usHoliday' && x.date==='2027-01-01' && /快照/.test(x.provenance)));
  assert.ok(all.some(x=>x.type==='usHoliday' && x.date==='2026-11-27' && /Finance Calendar/.test(x.provenance)));
  fail=true; await c.refresh(); all=c.events(); assert.ok(all.some(x=>x.type==='cpi' && /缓存.*更新失败/.test(x.provenance)));
  const restarted=new ReminderController(h.context,{online,now,provider:{fetch:async()=>{throw new Error('离线');}}});
  assert.ok(restarted.events().some(x=>x.type==='cpi' && /Finance Calendar.*缓存/.test(x.provenance)));
  c.dispose();restarted.dispose();
});
test('财经查询窗口跨天保持稳定，方便离线使用缓存',()=>{
  assert.deepEqual(ranges(Date.parse('2026-10-30T00:00:00Z')),ranges(Date.parse('2026-10-31T00:00:00Z')));
});
