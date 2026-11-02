'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { eastmoneyUrl, eastmoneyChartUrl, supportsChips, parseChart, parseFiveDayChart, ChartProvider } = require('../src/chart-data');
const symbol = 'sh600519';
const wrap = data => ({ code: 0, data: { [symbol]: data } });

test('历史换手率按证券、周期及时间解析并缓存，非法数值不使用', async () => {
  let calls = 0, lastUrl;
  const provider = new ChartProvider(async url => { calls++; lastUrl = url; return {rc:0,data:{code:'600519',market:1,klines:['2026-10-29,1,1,1,1,1,1,1,1,1,2.35','2026-10-30,1,1,1,1,1,1,1,1,1,0','2026-10-31,1,1,1,1,1,1,1,1,1,-1']}}; });
  const rates = await provider.loadHistoricalTurnover(symbol, 'daily');
  assert.equal(rates.get('2026-10-29'),2.35); assert.equal(rates.get('2026-10-30'),0); assert.equal(rates.has('2026-10-31'),false);
  assert.match(lastUrl,/klt=101/); await provider.loadHistoricalTurnover(symbol,'daily'); assert.equal(calls,1);
  await provider.loadHistoricalTurnover(symbol,'intraday5'); assert.equal(calls,2);
  await provider.loadHistoricalTurnover('sh000001','daily'); assert.equal(calls,2);
  const wrong = new ChartProvider(async()=>({rc:0,data:{code:'000001',market:1,klines:[]}}));
  await assert.rejects(wrong.loadHistoricalTurnover(symbol,'daily'),/不可用/);
});
test('分钟换手率保留准确的周期结束时间', async () => {
  const p = new ChartProvider(async()=>({rc:0,data:{code:'600519',market:1,klines:['2026-10-29 10:05,1,1,1,1,1,1,1,1,1,0.12']}}));
  const rates=await p.loadHistoricalTurnover(symbol,'m5'); assert.equal(rates.get('2026-10-29 10:05'),0.12); assert.equal(rates.has('2026-10-29'),false);
});

test('东方财富失败时使用搜狐对应证券与周期的历史换手率', async () => {
  const seen=[]; const p=new ChartProvider(async url=>{
    seen.push(url); if(url.includes('eastmoney')) throw new Error('socket hang up');
    return [{status:0,code:'cn_600519',hq:[['2026-10-16','','','','','','','','','7.26%'],['2026-10-15','','','','','','','','','0.00%'],['2026-10-14','','','','','','','','','--']]}];
  });
  const bars=[{time:'2026-10-15'},{time:'2026-10-16'}]; const rates=await p.loadHistoricalTurnover(symbol,'daily',undefined,{bars});
  assert.equal(rates.source,'搜狐财经'); assert.equal(rates.get('2026-10-16'),7.26); assert.equal(rates.get('2026-10-15'),0); assert.equal(rates.has('2026-10-14'),false);
  assert.match(seen[1],/start=20261015&end=20261016.*period=d/);
  await p.loadHistoricalTurnover(symbol,'daily',undefined,{bars}); assert.equal(seen.length,2);
  await p.loadHistoricalTurnover(symbol,'weekly',undefined,{bars}); assert.match(seen[3],/period=w/);
  await p.loadHistoricalTurnover(symbol,'monthly',undefined,{bars}); assert.match(seen[5],/period=m/);
});
test('来源代码错误不使用，失败限频但手动刷新可重试；取消不会请求备用源', async () => {
  let calls=0, works=false;const p=new ChartProvider(async url=>{calls++;if(works && url.includes('eastmoney'))return {rc:0,data:{code:'600519',market:1,klines:['2026-10-16,1,1,1,1,1,1,1,1,1,1.8']}};
    if(url.includes('eastmoney')) throw new Error('socket hang up');return [{status:0,code:'cn_000001',hq:[['2026-10-16','','','','','','','','','2.00%']]}];});
  await assert.rejects(p.loadHistoricalTurnover(symbol,'daily'),/搜狐财经/);assert.equal(calls,2);
  await assert.rejects(p.loadHistoricalTurnover(symbol,'daily'),/搜狐财经/);assert.equal(calls,2);
  works=true;assert.equal((await p.loadHistoricalTurnover(symbol,'daily',undefined,{force:true})).get('2026-10-16'),1.8);assert.equal(calls,3);
  const abort=new AbortController();let invoked=0;const cancelled=new ChartProvider(async()=>{invoked++;abort.abort();throw new Error('cancel');});
  await assert.rejects(cancelled.loadHistoricalTurnover(symbol,'daily',abort.signal),/cancel/);assert.equal(invoked,1);
});
test('五日分时的短窗口缓存不会截断日K的历史窗口',async()=>{
  const urls=[];const p=new ChartProvider(async url=>{urls.push(url);if(url.includes('eastmoney'))throw new Error('offline');return [{status:0,code:'cn_600519',hq:[['2026-10-16','','','','','','','','','2.00%']]}];});
  await p.loadHistoricalTurnover(symbol,'intraday5',undefined,{bars:[{date:'2026-10-26'},{date:'2026-10-30'}]});
  await p.loadHistoricalTurnover(symbol,'daily',undefined,{bars:[{time:'2026-10-01'},{time:'2026-10-30'}]});
  assert.equal(urls.length,4);assert.match(urls[1],/start=20261026/);assert.match(urls[3],/start=20261001/);
});
test('更新失败后保留已取得的历史换手率并标记缓存', async () => {
  let fail=false;const p=new ChartProvider(async()=>{if(fail)throw new Error('offline');return {rc:0,data:{code:'600519',market:1,klines:['2026-10-16,1,1,1,1,1,1,1,1,1,1.25']}};});
  await p.loadHistoricalTurnover(symbol,'daily');fail=true;const cached=await p.loadHistoricalTurnover(symbol,'daily',undefined,{force:true});
  assert.equal(cached.get('2026-10-16'),1.25);assert.equal(cached.stale,true);assert.equal(cached.source,'东方财富');assert.ok(cached.fetchedAt);
});

test('图表提取最新报价换手率及时间，缺失或代码不匹配不冒充有效行情',()=>{
  const q=Array(39).fill(''); q[1]='测试股'; q[2]='600519'; q[4]='9'; q[30]='20261030110000'; q[38]='2.35';
  const bars={day:[['2026-10-29','10','11','12','9','100']]};
  let parsed=parseChart(wrap({...bars,qt:{[symbol]:q}}),symbol,'daily');
  assert.equal(parsed.turnoverRate,2.35); assert.equal(parsed.turnoverTimestamp,'20261030110000');
  q[38]='0'; assert.equal(parseChart(wrap({...bars,qt:{[symbol]:q}}),symbol,'daily').turnoverRate,0);
  for(const bad of ['','NaN','-1']) { q[38]=bad; assert.equal(parseChart(wrap({...bars,qt:{[symbol]:q}}),symbol,'daily').turnoverRate,null); }
  q[38]='2.35'; q[2]='000001'; parsed=parseChart(wrap({...bars,qt:{[symbol]:q}}),symbol,'daily'); assert.equal(parsed.turnoverRate,null); assert.equal(parsed.turnoverTimestamp,null);
  q[2]='600519'; q[30]='20260230110000'; assert.equal(parseChart(wrap({...bars,qt:{[symbol]:q}}),symbol,'daily').turnoverRate,null);
  assert.equal(parseChart({code:0,data:{sh000001:bars}},'sh000001','daily').turnoverApplicable,false);
});

test('五日分时按日期升序保留全部分钟、每天重新计算成交量和均价', () => {
  const q=Array(35).fill(''); q[1]='测试股';q[4]='9.5';q[30]='20261030110000';
  const days=Array.from({length:5},(_,i)=>({date:`202610${30-i}`,data:Array.from({length:100},(_,j)=>`${String(9+Math.floor((30+j)/60)).padStart(2,'0')}${String((30+j)%60).padStart(2,'0')} 10 ${100+j} ${(100+j)*1000}`)}));
  const parsed=parseFiveDayChart(wrap({data:days,qt:{[symbol]:q}}),symbol);
  assert.equal(parsed.bars.length,500);assert.equal(parsed.dates[0],'2026-10-26');assert.equal(parsed.dates[4],'2026-10-30');
  assert.equal(parsed.bars[0].volume,100);assert.equal(parsed.bars[100].volume,100);assert.equal(parsed.bars[101].volume,1);assert.equal(parsed.bars[100].averagePrice,10);
  assert.equal(parsed.bars[0].previousClose,null);assert.equal(parsed.bars.at(-1).previousClose,9.5);assert.equal(parsed.bars.at(-1).date,'2026-10-30');
  assert.throws(()=>parseFiveDayChart(wrap({data:[days[0],days[0]]}),symbol),/日期重复/);
});
test('五日分时主域名失败时使用备用域名，不与单日分时冷却混淆', async () => {
  const calls=[],day={date:'20261030',data:['0930 10 100 100000']};
  const p=new ChartProvider(async url=>{calls.push(url);if(url.includes('web.ifzq'))throw new Error('断连');return wrap({data:[day]});});
  const result=await p.load(symbol,'intraday5');assert.equal(result.bars.length,1);assert.match(result.source,/备用/);
  assert.equal(calls.length,2);assert.ok(calls.every(url=>url.includes('/day/query?code=sh600519')));
});

test('股票及ETF分时成交均价按累计成交额元除以累计手数乘100，缺额不伪造均价', () => {
  for (const symbol of ['sh600105', 'sh510300', 'sz159915', 'bj920002']) {
    const input = { code: 0, data: { [symbol]: { data: { date: '20261028', data: [
      '0930 10 100 100000', '0931 12 300 340000', '0932 12 300 340000',
      '0933 13 400', '0934 14 500 610000', '0935 14 600 750000'
    ] } } } };
    const { bars } = parseChart(input, symbol, 'intraday');
    assert.equal(bars[0].averagePrice, 10);
    assert.equal(bars[1].averagePrice, 340000 / 30000);
    assert.equal(bars[1].amount, 240000); assert.equal(bars[1].volume, 200);
    assert.equal(bars[2].amount, 0); assert.equal(bars[2].averagePrice, bars[1].averagePrice);
    assert.equal(bars[3].averagePrice, null); assert.equal(bars[3].cumulativeAmount, null);
    assert.equal(bars[4].amount, null); assert.equal(bars[4].averagePrice, 12.2);
    assert.equal(bars[5].amount, 140000);
  }
});
test('指数不从成分股聚合成交量伪造均价；无量与错误成交额保留价格图', () => {
  const make = (s, rows) => parseChart({ code: 0, data: { [s]: { data: { date: '20261028', data: rows } } } }, s, 'intraday');
  assert.equal(make('sh000001', ['0930 3000 100 100000']).bars[0].averagePrice, null);
  const { bars } = make('sh600105', ['0930 10 0 0', '0931 10 100 100000', '0932 10 200 90000', '0933 10 300 NaN']);
  assert.equal(bars[0].averagePrice, null); assert.equal(bars[1].averagePrice, 10);
  assert.equal(bars[2].averagePrice, null); assert.equal(bars[3].averagePrice, null);
});
test('东方财富区分个股、沪深指数和北交所路径，拒绝URL注入', () => {
  assert.equal(eastmoneyUrl('600519.SH'), 'https://quote.eastmoney.com/sh600519.html');
  assert.equal(eastmoneyUrl('000001'), 'https://quote.eastmoney.com/sz000001.html');
  assert.equal(eastmoneyUrl('sh000001'), 'https://quote.eastmoney.com/zs000001.html');
  assert.equal(eastmoneyUrl('sz399001'), 'https://quote.eastmoney.com/zs399001.html');
  assert.equal(eastmoneyUrl('bj920002'), 'https://quote.eastmoney.com/bj/920002.html');
  assert.throws(() => eastmoneyUrl('https://evil.example/'));
});
test('专用图表正确映射沪深及北交所；筹码盘口只向沪深A股开放', () => {
  assert.equal(eastmoneyChartUrl('sh600105'), 'https://quote.eastmoney.com/basic/full.html?mcid=1.600105');
  assert.equal(eastmoneyChartUrl('000001'), 'https://quote.eastmoney.com/basic/full.html?mcid=0.000001');
  assert.equal(eastmoneyChartUrl('sh000001'), 'https://quote.eastmoney.com/basic/full.html?mcid=1.000001');
  assert.equal(eastmoneyChartUrl('bj920002'), 'https://quote.eastmoney.com/basic/full.html?mcid=0.920002');
  for (const symbol of ['sh600105', 'sh688001', 'sz000001', 'sz002594', 'sz300750', 'sz301001']) {
    assert.equal(supportsChips(symbol), true);
    assert.equal(eastmoneyChartUrl(symbol, 'chips'), `https://quote.eastmoney.com/basic/h5chart-iframe.html?code=${symbol.slice(2)}&market=${symbol.startsWith('sh') ? 1 : 0}`);
  }
  for (const symbol of ['sh000001', 'sz399001', 'sh510300', 'sz159915', 'bj920002']) {
    assert.equal(supportsChips(symbol), false);
    assert.equal(eastmoneyChartUrl(symbol, 'chips'), eastmoneyChartUrl(symbol));
  }
  assert.throws(() => eastmoneyChartUrl('https://evil.example'));
});
test('分时成交量为累计值，图表柱使用相邻差额；跳过集合竞价与零价格', () => {
  const result = parseChart(wrap({ data: { date: '20261026', data: ['0925 0 0', '0930 10.01 100', '0931 10.02 140', '0932 10.02 140', '1300 10.03 220'] } }), symbol, 'intraday');
  assert.deepEqual(result.bars.map(b => b.volume), [100, 40, 0, 80]);
  assert.equal(result.bars[1].close, 10.02); assert.equal(result.date, '2026-10-26');
  assert.throws(() => parseChart(wrap({ data: { date: '20261026', data: ['0930 10 100', '0931 10 99'] } }), symbol, 'intraday'), /顺序/);
});
test('日K按照开收高低字段解析，优先前复权，指数无复权时明确标记', () => {
  const rows = [['2026-10-23', '10', '11', '12', '9', '1000'], ['2026-10-26', '11', '10', '11.5', '9.5', '2000']];
  const qfq = parseChart(wrap({ qfqday: rows }), symbol, 'daily');
  assert.equal(qfq.adjustment, '前复权'); assert.deepEqual(qfq.bars[0], { time: '2026-10-23', open: 10, close: 11, high: 12, low: 9, volume: 1000 });
  assert.equal(parseChart(wrap({ day: rows }), symbol, 'daily').adjustment, '不复权');
  assert.throws(() => parseChart(wrap({ day: [['2026-10-26', '10', '11', '9', '8', '100']] }), symbol, 'daily'), /价格/);
  assert.throws(() => parseChart(wrap({ day: [['2026-02-30', '10', '11', '12', '9', '100']] }), symbol, 'daily'), /日期/);
  assert.throws(() => parseChart(wrap({ day: [] }), symbol, 'daily'), /暂无/);
});
test('图表请求只使用已校验代码与固定数据域名，取消信号传递到底层', async () => {
  const signal = new AbortController().signal, calls = [];
  const provider = new ChartProvider(async (url, s) => { calls.push([url, s]); return wrap({ day: [['2026-10-26', '10', '11', '12', '9', '100']] }); });
  await provider.load('600519', 'daily', signal);
  assert.match(calls[0][0], /^https:\/\/web\.ifzq\.gtimg\.cn\/appstock\/app\/fqkline\/get\?param=sh600519,/); assert.equal(calls[0][1], signal);
  await assert.rejects(provider.load('600519', 'other', signal), /类型/);
});

test('日周月分别请求对应周期及240根历史，不将日线冒充周月线', async () => {
  const modes = { daily: 'day', weekly: 'week', monthly: 'month' };
  for (const [mode, period] of Object.entries(modes)) {
    const rows = [['2026-09-30', '10', '11', '12', '9', '1000'], ['2026-10-28', '11', '12', '13', '10', '2200']];
    const provider = new ChartProvider(async url => {
      assert.equal(new URL(url).searchParams.get('param'), `${symbol},${period},,,240,qfq`);
      return wrap({ ['qfq' + period]: rows, day: [['2026-10-28', '99', '99', '99', '99', '1']] });
    });
    const data = await provider.load(symbol, mode);
    assert.equal(data.mode, mode); assert.equal(data.bars.length, 2); assert.equal(data.bars.at(-1).volume, 2200);
    assert.equal(data.adjustment, '前复权'); assert.equal(data.date, '2026-10-28');
    assert.equal(parseChart(wrap({ [period]: rows }), symbol, mode).adjustment, '不复权');
    if (mode !== 'daily') assert.throws(() => parseChart(wrap({ day: rows }), symbol, mode), /缺少/);
  }
});

test('长期前复权允许历史负价格但仍拒绝负成交量、未复权负价格和错误高低价', () => {
  const row = ['2008-10-31', '0.219', '-0.004', '0.307', '-0.015', '610703.350'];
  const data = parseChart(wrap({ qfqmonth: [row] }), symbol, 'monthly');
  assert.equal(data.bars[0].close, -.004); assert.equal(data.bars[0].low, -.015);
  assert.throws(() => parseChart(wrap({ month: [row] }), symbol, 'monthly'), /价格/);
  assert.throws(() => parseChart(wrap({ qfqmonth: [[...row.slice(0, 5), '-1']] }), symbol, 'monthly'), /成交量/);
  assert.throws(() => parseChart(wrap({ qfqmonth: [['2008-10-31', '.2', '-.004', '.1', '-.015', '100']] }), symbol, 'monthly'), /价格/);
});
