'use strict';
const data = require('./event-calendar-data');
const { requestBuffer } = require('./http');
const DAY = 86400000;
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const LABELS = { fed: '美联储议息', delivery: '股指交割', cnHoliday: 'A股休市', hkHoliday: '港股休市', usHoliday: '美股休市', nonfarm: '美国非农', cpi: '美国CPI' };

// 将交易所当地时间转换为绝对时间；不能依赖运行 VS Code 的电脑时区。
function zonedTime(date, time, zone) {
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(time)) throw new Error('日期格式无效');
  const [y,m,d] = date.split('-').map(Number), [h,minute] = time.split(':').map(Number);
  const target = Date.UTC(y,m-1,d,h,minute);
  if (new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10) !== date || h > 23 || minute > 59) throw new Error('日期无效');
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let value = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(value)).map(x => [x.type,x.value]));
    const observed = Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);
    if (observed === target) return value;
    value += target - observed;
  }
  throw new Error('当地时间不存在');
}
function beijing(ms) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).format(new Date(ms));
}
function event(type, date, time, zone, name, detail, extra = {}) {
  return { id: `${type}:${date}:${name}`, type, name, date, time, zone, when: zonedTime(date,time,zone), detail, source: data.SOURCES[type], ...extra };
}
function snapshotEvent(type, date) {
  const fed = type === 'fed';
  return event(type,date,fed ? '14:00' : '08:30','America/New_York',LABELS[type], fed ? '常规决议时间预计为美东14:00，具体以美联储公告为准。' : '公布时间为美东08:30，可能因官方调整变化。', { provenance: `官方日历快照 ${data.SNAPSHOT_DATE}，未在线核实` });
}
function shift(date, days) { return new Date(Date.parse(date+'T00:00:00Z') + days*DAY).toISOString().slice(0,10); }
function cnClosed(date, extra) {
  const weekday = new Date(date+'T00:00:00Z').getUTCDay();
  return weekday === 0 || weekday === 6 || extra.includes(date) || data.CN.some(([,start,end]) => date >= start && date <= end);
}
function holiday(type, name, start, end, detail, zone = 'Asia/Shanghai') {
  const localEnd = end || start;
  return event(type,start,'09:30',zone,`${LABELS[type]}·${name}`,detail, { allDay:true, end: zonedTime(localEnd,'23:59',zone)+60000, provenance:`官方公告快照 ${data.SNAPSHOT_DATE}，临时调整未自动同步` });
}
function staticEvents(extra = []) {
  const result = [];
  for (const [name,start,end,resume] of data.CN) {
    let last = shift(start,-1); while (cnClosed(last,extra)) last = shift(last,-1);
    let next = resume; while (next.startsWith('2026-') && cnClosed(next,extra)) next = shift(next,1);
    result.push(holiday('cnHoliday',name,start,end,`休市 ${start} 至 ${end}；预计复市 ${next}；节前最后交易日 ${last}。以交易所公告为准。`));
  }
  for (let month=1;month<=12;month++) {
    let date = `2026-${String(month).padStart(2,'0')}-15`;
    while (new Date(date+'T00:00:00Z').getUTCDay() !== 5) date = shift(date,1);
    while (cnClosed(date,extra)) date = shift(date,1);
    result.push(event('delivery',date,'15:00','Asia/Shanghai','A股股指期货交割', '按中金所第三个周五、遇法定节假日顺延规则推算；具体合约及临时调整以中金所公告为准。', { provenance: '规则推算；A股休市日历覆盖 2026 年' }));
  }
  for (const [name,start,end] of data.HK) result.push(holiday('hkHoliday',name,start,end,`港股休市 ${start}${end ? ' 至 '+end : ''}；复市以港交所公告为准。`));
  for (const [name,date] of data.HK_HALF) {
    const e = holiday('hkHoliday',name,date,date,`港股半日市：${date} 下午休市，收市竞价约至 12:10，以港交所公告为准。`);
    e.name = `港股半日市·${name}`; result.push(e);
  }
  for (const [name,date] of data.US) result.push(holiday('usHoliday',name,date,date,`美股 ${date} 休市（美东日期），以交易所公告为准。`,'America/New_York'));
  for (const [name,date] of data.US_EARLY) result.push(event('usHoliday',date,'13:00','America/New_York',`美股提前收盘·${name}`,`美股 ${date} 美东 13:00 提前收盘，以交易所公告为准。`, { provenance:`官方公告快照 ${data.SNAPSHOT_DATE}，临时调整未自动同步` }));
  return result;
}
function clean(html) { return html.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim(); }
function parseBls(html, type) {
  if (type !== 'nonfarm' && type !== 'cpi') throw new Error('未知日历');
  const out = [], seen = new Set();
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(m[1]));
    if (cells.length < 3 || !/^[A-Za-z]+\s+20\d\d$/.test(cells[0])) continue;
    const m = cells[1].match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(20\d\d)$/), t = cells[2].match(/^(\d{1,2}):(\d\d)\s*(AM|PM)$/i);
    if (!m || !t) throw new Error('劳工统计局日历日期格式变更');
    const month = MONTHS.findIndex(x => x.startsWith(m[1].toLowerCase()));
    if (month < 0 || +t[1] < 1 || +t[1] > 12 || +t[2] > 59 || seen.has(cells[0])) throw new Error('劳工统计局日历字段无效');
    const date = `${m[3]}-${String(month+1).padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    const hour = (+t[1] % 12) + (t[3].toUpperCase() === 'PM' ? 12 : 0);
    const e = event(type,date,`${String(hour).padStart(2,'0')}:${t[2]}`,'America/New_York',LABELS[type],`统计期 ${cells[0]}；公布时间以美国劳工统计局公告为准。`);
    seen.add(cells[0]); out.push(e);
  }
  if (out.length < 3 || new Set(out.map(e => e.id)).size !== out.length) throw new Error('劳工统计局日历未识别或数据不足');
  return out;
}
function parseFed(html) {
  const headings = [...html.matchAll(/(20\d\d)\s+FOMC Meetings\s*<\/a>/gi)];
  const out = [];
  for (let i=0;i<headings.length;i++) {
    const year = headings[i][1], section = html.slice(headings[i].index, headings[i+1]?.index || html.length), rows = [];
    if (+year < 2026) continue;
    const re = /class="[^"]*\bfomc-meeting__month\b[^"]*"[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]{0,1000}?class="[^"]*\bfomc-meeting__date\b[^"]*"[^>]*>([^<]+)</gi;
    for (const row of section.matchAll(re)) {
      const label = clean(row[1]).toLowerCase().split('/').pop(), month = MONTHS.findIndex(m => m === label || m.slice(0,3) === label), date = clean(row[2]).match(/^(?:\d{1,2}\s*[-–]\s*)?(\d{1,2})\s*\*?$/);
      if (/notation vote/i.test(row[2])) continue;
      if (month < 0 || !date) throw new Error('美联储会议日历格式变更');
      const day = `${year}-${String(month+1).padStart(2,'0')}-${date[1].padStart(2,'0')}`;
      rows.push(snapshotEvent('fed',day));
    }
    if (rows.length < 6 || rows.length > 12) throw new Error('美联储会议日历数量异常');
    out.push(...rows);
  }
  if (!out.length || new Set(out.map(e=>e.id)).size !== out.length) throw new Error('美联储会议日历未识别或重复');
  return out;
}
class CalendarProvider {
  constructor(fetch = async (url,signal) => (await requestBuffer(url,signal,{Referer:'', 'User-Agent':'Mozilla/5.0'})).toString('utf8')) { this.fetch = fetch; }
  async load(type, signal) {
    const html = await this.fetch(data.SOURCES[type], signal);
    return type === 'fed' ? parseFed(html) : parseBls(html,type);
  }
}
module.exports = { LABELS, DAY, beijing, zonedTime, staticEvents, snapshotEvent, parseBls, parseFed, CalendarProvider };
