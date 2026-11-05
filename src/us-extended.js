'use strict';
const { requestBuffer } = require('./http');
const { normalizeOverseas } = require('./overseas-symbols');
const { normalizeDate, timeToMinute } = require('./market');
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
const number = value => typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
function usClock(now) {
  const p = Object.fromEntries(clockFormat.formatToParts(now).map(p => [p.type, p.value]));
  const minute = Number(p.hour) * 60 + Number(p.minute), weekday = !['Sat', 'Sun'].includes(p.weekday);
  const phase = !weekday ? 'closed' : minute >= 240 && minute < 570 ? 'pre' : minute >= 570 && minute < 960 ? 'regular' : minute >= 960 && minute < 1200 ? 'post' : 'closed';
  return { date: `${p.year}-${p.month}-${p.day}`, timestamp: p.year + p.month + p.day + p.hour + p.minute + p.second, minute, weekday, phase, polling: phase === 'regular', quotePolling: weekday && minute >= 240 && minute < 1202 };
}
function parseTime(text, year) {
  const m = typeof text === 'string' && text.trim().match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s+(EST|EDT)$/);
  if (!m || !Number.isInteger(year) || year < 2000 || year > 2100 || !MONTHS.includes(m[1]) || +m[3] < 1 || +m[3] > 12 || +m[4] > 59 || +(m[5] || 0) > 59) return null;
  const pad = n => String(n).padStart(2, '0'), hour = +m[3] % 12 + (m[6] === 'PM' ? 12 : 0);
  const date = `${year}-${pad(MONTHS.indexOf(m[1]) + 1)}-${pad(+m[2])}`, time = `${pad(hour)}:${m[4]}:${m[5] || '00'}`;
  const epoch = Date.parse(`${date}T${time}${m[7] === 'EST' ? '-05:00' : '-04:00'}`);
  if (!Number.isFinite(epoch)) return null;
  const actual = usClock(new Date(epoch)), timestamp = (date + time).replace(/[-:]/g, '');
  // Validate calendar dates and the supplied EST/EDT offset against New York.
  if (actual.timestamp !== timestamp || !actual.weekday) return null;
  return { epoch, date, timestamp, minute: hour * 60 + +m[4], zone: m[7], precision: m[5] === undefined ? 'minute' : 'second' };
}
function closeEnough(price, base, delta, percent) {
  return Math.abs(price - base - delta) <= Math.max(.02, price * .000001) && Math.abs((price / base - 1) * 100 - percent) <= .03;
}
function validExtended(q, now = new Date()) {
  try {
    if (!q || normalizeOverseas(q.symbol, 'us') !== q.symbol || !['pre', 'post'].includes(q.phase) || typeof q.name !== 'string' || !q.name || q.name.length > 100 || q.source !== '新浪财经') return false;
    if (![q.price, q.basePrice, q.delta, q.percent, q.epoch].every(Number.isFinite) || q.price <= 0 || q.basePrice <= 0 || number(q.priceText) !== q.price || !closeEnough(q.price, q.basePrice, q.delta, q.percent)) return false;
    if (q.epoch > now.getTime() + 300000 || now.getTime() - q.epoch > 7 * 86400000 || !/^\d{14}$/.test(q.timestamp || '')) return false;
    const clock = usClock(new Date(q.epoch));
    if (clock.timestamp !== q.timestamp || clock.date !== q.date || !clock.weekday || !/^\d{14}$/.test(q.regularTimestamp || '') || !Number.isFinite(q.baseEpoch) || usClock(new Date(q.baseEpoch)).timestamp !== q.regularTimestamp || q.baseEpoch > q.epoch + (q.phase === 'post' ? 900000 : 0)) return false;
    normalizeDate(q.regularTimestamp.slice(0, 8));
    const regularMinute = timeToMinute(q.regularTimestamp.slice(8, 12));
    if (Number(q.regularTimestamp.slice(12)) > 59) return false;
    return q.phase === 'pre' ? clock.minute >= 240 && clock.minute < 570 && q.regularTimestamp.slice(0, 8) < q.timestamp.slice(0, 8)
      : clock.minute >= (q.earlyClose ? 780 : 960) && clock.minute <= 1200 && q.regularTimestamp.slice(0, 8) === q.timestamp.slice(0, 8) && regularMinute >= 570 && regularMinute <= 975;
  } catch { return false; }
}
function sinaCode(symbol) { return 'gb_' + normalizeOverseas(symbol, 'us').slice(2).toLowerCase().replaceAll('.', '$'); }
function parseExtended(text, symbols, now = new Date()) {
  const wanted = new Map(symbols.map(s => [sinaCode(s), s])), quotes = new Map(), errors = new Map(), unavailable = new Set();
  for (const match of String(text).matchAll(/\bvar\s+hq_str_(gb_[a-z0-9_$]+)\s*=\s*"([^"\r\n]*)"\s*;/gi)) {
    const symbol = wanted.get(match[1].toLowerCase()); if (!symbol) continue;
    const f = match[2].split(',');
    if (!f[24] || !(number(f[21]) > 0)) { unavailable.add(symbol); continue; }
    try {
      // Sina exposes an independent extended quote: price[21], percent[22],
      // change[23], NY trade time[24]. [3] is feed update time, not trade time.
      const sourceTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(f[3]) ? Date.parse(f[3].replace(' ', 'T') + '+08:00') : NaN;
      if (!Number.isFinite(sourceTime) || sourceTime > now.getTime() + 300000 || new Date(sourceTime + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') !== f[3]) throw new Error('盘前盘后来源时间无效');
      const year = new Date(sourceTime).getUTCFullYear();
      const candidates = [...new Set([Number(f[29]), year - 1, year, year + 1])].map(y => parseTime(f[24], y)).filter(t => t && t.epoch <= sourceTime + 300000 && sourceTime - t.epoch < 7 * 86400000).sort((a, b) => b.epoch - a.epoch);
      const time = candidates[0]; if (!time) throw new Error('盘前盘后行情时间缺失或过期');
      const regular = [year - 1, year, year + 1].map(y => parseTime(f[25], y)).filter(t => t && t.epoch <= time.epoch + (time.minute >= 780 ? 900000 : 0) && time.epoch - t.epoch < 7 * 86400000).sort((a, b) => b.epoch - a.epoch)[0];
      if (!regular) throw new Error('无法确认常规收盘基准时间');
      const phase = time.minute >= 240 && time.minute < 570 ? 'pre' : time.minute >= 780 && time.minute <= 1200 && time.date === regular.date ? 'post' : null;
      if (!phase) throw new Error('该报价不属于盘前或盘后时段');
      const price = number(f[21]), delta = number(f[23]), percent = number(f[22]);
      // [35] is the extended session's closing reference; it may differ from
      // the headline price [1] after closing-auction corrections (e.g. BRK.B).
      const basePrice = [number(f[35]), number(f[1])].find(base => base > 0 && closeEnough(price, base, delta, percent));
      const quote = { symbol, name: f[0].slice(0, 100), phase, price, priceText: f[21].replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'), basePrice, delta, percent, date: time.date, timestamp: time.timestamp, timePrecision: time.precision, epoch: time.epoch, zone: time.zone, regularTimestamp: regular.timestamp, baseEpoch: regular.epoch, earlyClose: phase === 'post' && time.minute < 960, source: '新浪财经' };
      if (!validExtended(quote, now)) throw new Error('盘前盘后报价或涨跌基准不一致');
      quotes.set(symbol, quote);
    } catch (error) { errors.set(symbol, error.message); }
  }
  for (const symbol of symbols) if (!quotes.has(symbol) && !errors.has(symbol)) unavailable.add(symbol);
  return { quotes, errors, unavailable };
}
class UsExtendedProvider {
  constructor(request = async (url, signal) => new TextDecoder('gb18030').decode(await requestBuffer(url, signal, { Referer: 'https://finance.sina.com.cn/' }))) { this.request = request; }
  async load(symbols, signal, now = new Date()) {
    if (signal?.aborted) throw new Error('盘前盘后行情请求已取消');
    const quotes = new Map(), errors = new Map(), unavailable = new Set(), batches = [];
    for (let i = 0; i < symbols.length; i += 50) batches.push(symbols.slice(i, i + 50));
    await Promise.all(batches.map(async batch => {
      try {
        const result = parseExtended(await this.request(`https://hq.sinajs.cn/list=${batch.map(sinaCode).join(',')}`, signal), batch, now);
        for (const [s, q] of result.quotes) quotes.set(s, q);
        for (const [s, e] of result.errors) errors.set(s, e);
        for (const s of result.unavailable) unavailable.add(s);
      } catch (error) { for (const s of batch) errors.set(s, error.message || '盘前盘后行情获取失败'); }
    }));
    if (signal?.aborted) throw new Error('盘前盘后行情请求已取消');
    return { quotes, errors, unavailable };
  }
}
module.exports = { UsExtendedProvider, usClock, parseTime, parseExtended, validExtended, sinaCode };
