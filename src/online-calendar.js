'use strict';
const { requestBuffer } = require('./http');
const { LABELS, DAY, beijing, event, holiday, shift } = require('./event-calendar');
const data = require('./event-calendar-data');
const MARKETS = { SSE:'cnHoliday', HKEX:'hkHoliday', NYSE:'usHoliday' };
const SERIES = { fed:'fomc', nonfarm:'us-nfp', cpi:'us-cpi' };
const HEADERS = { Referer:'', 'User-Agent':'A-Share-Turnover/1.18 (+https://github.com/welove42/a-share-turnover)' };
function json(text) { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('接口响应格式无效'); return v; }
function validDate(s) { return typeof s === 'string' && /^20\d\d-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s+'T00:00:00Z')) && new Date(s+'T00:00:00Z').toISOString().slice(0,10) === s; }
function safeName(s) { return typeof s === 'string' && s.length > 0 && s.length <= 100 && !/[\x00-\x1f]/.test(s); }
function parseHolidays(text, market, year) {
  const p = json(text), type = MARKETS[market];
  if (!type || p.market_id !== market || p.year !== year || p.coverage !== 'loaded' || p.review_state !== 'verified' || !/^[a-zA-Z0-9._-]{1,60}$/.test(p.data_version || '') || !Array.isArray(p.holidays) || p.holidays.length < 3 || p.holidays.length > 50) throw new Error('交易日历年份未覆盖或未经核实');
  const events = [], days = new Set();
  for (const row of p.holidays) {
    const name = row.zh || row.name, rec = row.record;
    if (!safeName(name) || !validDate(row.start) || !validDate(row.end) || row.start > row.end || !row.start.startsWith(`${year}-`) || !row.end.startsWith(`${year}-`) || rec?.market_id !== market || rec.status !== 'closed' || rec.is_trading_day !== false || rec.review_state !== 'verified' || days.has(row.start)) throw new Error('交易日历休市字段异常');
    days.add(row.start);
    const e = holiday(type,name,row.start,row.end,`当地休市 ${row.start}${row.end !== row.start ? ' 至 '+row.end : ''}；以交易所公告为准。`,market === 'NYSE' ? 'America/New_York' : 'Asia/Shanghai');
    e.detail += ` 数据版本 ${p.data_version}；原公告核查日期 ${validDate(rec.source_checked_at) ? rec.source_checked_at : '未知'}。`;
    events.push(e);
  }
  return { events, version:p.data_version };
}
function parseTradingDays(text, year) {
  const p=json(text), start=`${year}-01-01`, end=`${year}-12-31`, daysInYear = (Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/DAY+1;
  if (p.start !== start || p.end !== end || !Array.isArray(p.days) || p.days.length !== daysInYear || !/^[a-zA-Z0-9._-]{1,60}$/.test(p.data_version || '')) throw new Error('逐日交易日历不完整');
  const days = new Map();
  for (let i=0;i<p.days.length;i++) {
    const row=p.days[i], s=row.markets?.SSE, h=row.markets?.HKEX, date=shift(start,i);
    if (row.date !== date || !s || !h || !['open','closed','half_day'].includes(s.status) || !['open','closed','half_day'].includes(h.status) || typeof s.is_trading_day !== 'boolean' || typeof h.is_trading_day !== 'boolean' || (s.status === 'closed') === s.is_trading_day || (h.status === 'closed') === h.is_trading_day) throw new Error('逐日交易日历含未知或异常状态');
    days.set(date,{ sse:s.status, hk:h.status });
  }
  return { days, version:p.data_version };
}
function makeTradingEvents(parsed, year, extra=[]) {
  const half = [], deliveries=[];
  for (const [date,row] of parsed.days) if (row.hk === 'half_day') {
    const e=holiday('hkHoliday','半日市',date,date,`港股 ${date} 为半日市，具体交易时段以港交所公告为准。`);
    e.name='港股半日市'; half.push(e);
  }
  for(let m=1;m<=12;m++) {
    let day=`${year}-${String(m).padStart(2,'0')}-15`;
    while(new Date(day+'T00:00:00Z').getUTCDay()!==5) day=shift(day,1);
    while(parsed.days.has(day) && (parsed.days.get(day).sse === 'closed' || extra.includes(day))) day=shift(day,1);
    if (!parsed.days.has(day)) continue;
    deliveries.push(event('delivery',day,'15:00','Asia/Shanghai','A股股指期货交割','按中金所第三个周五顺延规则及在线 A 股交易日历推算，具体以中金所公告为准。'));
  }
  return { half, deliveries };
}
function parseEconomic(text, from, to) {
  const p=json(text);
  if (p.from!==from || p.to!==to || !Array.isArray(p.events) || p.count!==p.events.length || p.total!==p.count || p.count>500) throw new Error('财经日历窗口不完整');
  const found={fed:[],nonfarm:[],cpi:[]}, seen=new Set();
  for(const row of p.events) {
    const type=Object.keys(SERIES).find(k=>SERIES[k]===row.series_code); if (!type) continue;
    if (!validDate(row.date) || row.date<from || row.date>to || row.country!=='US' || !['confirmed','rescheduled','released','cancelled'].includes(row.status) || row.data_stale !== false || row.time_precision!=='minute' || typeof row.release_at_utc !== 'string' || !/T\d\d:\d\d:\d\d(?:Z|\+00:00)$/.test(row.release_at_utc)) throw new Error('财经日历包含未确认或无准确时间的事件');
    const when=Date.parse(row.release_at_utc); if (!Number.isFinite(when) || seen.has(type+':'+row.date)) throw new Error('财经日历时间无效或重复');
    seen.add(type+':'+row.date);
    const e=event(type,row.date,type==='fed'?'14:00':'08:30','America/New_York',LABELS[type],'财经日历记录；具体公布时间以官方公告为准。');
    e.when=when; if(row.status==='cancelled') { e.cancelled=true; e.name+='（已取消）'; }
    e.detail += ` 来源状态 ${row.status}；来源核查时间 ${typeof row.last_verified_at==='string' && /^20\d\d-\d\d-\d\dT[0-9:.+-]+(?:Z|\+00:00)$/.test(row.last_verified_at) ? row.last_verified_at : '未知'}。`; found[type].push(e);
  }
  return found;
}
function parseUsEarly(text,from,to) {
  const p=json(text); if(p.from!==from || p.to!==to || !Array.isArray(p.events) || p.count!==p.events.length || p.count!==p.total) throw new Error('美股节假日日历窗口不完整');
  const result=[], dates=new Set();
  for(const row of p.events) {
    if(row.exchange!=='nyse' || row.holiday_status!=='early_close') continue;
    if (!validDate(row.date) || row.date<from || row.date>to || !/^\d\d:\d\d$/.test(row.close_time_local || '') || row.data_stale!==false || dates.has(row.date)) throw new Error('美股提前收盘记录异常');
    dates.add(row.date); result.push(event('usHoliday',row.date,row.close_time_local,'America/New_York','美股提前收盘',`美东 ${row.close_time_local} 提前收盘；以交易所公告为准。`));
  }
  return result;
}
function ranges(now) {
  const start=beijing(now).slice(0,7)+'-01', out=[]; let from=start;
  for(let i=0;i<4;i++) { const to=shift(from,89); out.push([from,to]); from=shift(to,1); }
  return out;
}
class OnlineCalendar {
  constructor(fetch=async (url,signal)=>(await requestBuffer(url,signal,HEADERS)).toString('utf8')) { this.fetch=fetch; }
  marketUrl(market,year) { return `https://marketsopen.today/api/v1/markets/${market}/holidays?year=${year}`; }
  tradingUrl(year) { return `https://marketsopen.today/api/v1/trading-days?markets=SSE%2CHKEX&start=${year}-01-01&end=${year}-12-31`; }
  economicUrl(from,to) { return `https://www.financecalendar.com/wp-json/fc/v1/calendar?series=fomc%2Cus-nfp%2Cus-cpi&from=${from}&to=${to}&limit=500`; }
  earlyUrl(from,to) { return `https://www.financecalendar.com/wp-json/fc/v1/calendar?category=market-holidays&country=US&from=${from}&to=${to}&limit=500`; }
}
module.exports={ MARKETS,SERIES,parseHolidays,parseTradingDays,makeTradingEvents,parseEconomic,parseUsEarly,ranges,OnlineCalendar };
