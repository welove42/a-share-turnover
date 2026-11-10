import { DAY, event, type CalendarEvent } from './calendar';

export const WEEKLY_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const NYSE_URL = 'https://www.nyse.com/trade/hours-calendars';

/** 只识别三个确定的发布事件，不能把官员讲话、ADP 或核心 CPI 当成独立提醒。 */
export function parseWeekly(text: string) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000) throw new Error('周日历格式异常');
  const events = new Map<string, CalendarEvent>();
  const times: number[] = [];
  for (const row of rows) {
    if (typeof row.date !== 'string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(row.date))
      throw new Error('周日历缺少带时区的准确时间');
    const when = Date.parse(row.date);
    const dateOnly = new Date(row.date.slice(0, 10) + 'T00:00:00Z');
    if (
      !Number.isFinite(when) ||
      !Number.isFinite(dateOnly.getTime()) ||
      dateOnly.toISOString().slice(0, 10) !== row.date.slice(0, 10) ||
      +row.date.slice(11, 13) > 23
    )
      throw new Error('周日历日期无效');
    times.push(when);
    if (row.country !== 'USD') continue;
    const type = /^CPI (?:m\/m|y\/y)$/.test(row.title)
      ? 'cpi'
      : row.title === 'Non-Farm Employment Change'
        ? 'nonfarm'
        : ['FOMC Statement', 'Federal Funds Rate'].includes(row.title)
          ? 'fed'
          : undefined;
    if (!type) continue;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(when);
    const value = (key: string) => parts.find((p) => p.type === key)!.value;
    const date = `${value('year')}-${value('month')}-${value('day')}`;
    const e = event(
      type,
      date,
      `${value('hour')}:${value('minute')}`,
      'America/New_York',
      type === 'fed' ? '美联储议息' : type === 'nonfarm' ? '美国非农' : '美国CPI',
      'Forex Factory 本周公开日历；按来源时区转换，日期调整以发布机构公告为准。'
    );
    e.when = when;
    e.source = 'https://www.forexfactory.com/calendar';
    const key = type + ':' + date;
    if (events.has(key) && events.get(key)!.when !== when) throw new Error('周日历同类事件时间冲突');
    events.set(key, e);
  }
  const from = Math.min(...times),
    to = Math.max(...times);
  if (to - from > 8 * DAY) throw new Error('周日历范围异常');
  return { events: [...events.values()], from, to };
}

/** 解析 NYSE 官网页面的明确提前收盘公告，不根据节假日自行猜测时间。 */
export function parseNyseEarly(html: string) {
  const clean = (s: string) =>
    s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const header = clean(body).match(/All NYSE markets observe[\s\S]{0,150}?listed below for ([\d, and]+)\./i);
  const years = [...(header?.[1].match(/20\d\d/g) || [])];
  if (!years.length || years.length > 5) throw new Error('NYSE 日历覆盖年份未识别');
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ];
  const events = new Map<string, CalendarEvent>();
  for (const p of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const content = clean(p[1]);
    if (!/Each market will close early/i.test(content)) continue;
    const match = content.match(
      /Each market will close early at (\d{1,2}):(\d\d) ([ap])\.m\.[\s\S]*?\bon (.+?)(?:\. |$)/i
    );
    if (!match || +match[1] < 1 || +match[1] > 12 || +match[2] > 59) throw new Error('NYSE 提前收盘时间未识别');
    const time = `${String((+match[1] % 12) + (match[3].toLowerCase() === 'p' ? 12 : 0)).padStart(2, '0')}:${match[2]}`;
    const dates = [...match[4].matchAll(/([A-Za-z]+) (\d{1,2}), (20\d\d)/g)];
    if (!dates.length) throw new Error('NYSE 提前收盘日期未识别');
    for (const date of dates) {
      const month = months.indexOf(date[1]);
      if (month < 0 || !years.includes(date[3])) throw new Error('NYSE 提前收盘日期异常');
      const day = `${date[3]}-${String(month + 1).padStart(2, '0')}-${date[2].padStart(2, '0')}`;
      const e = event(
        'usHoliday',
        day,
        time,
        'America/New_York',
        '美股提前收盘',
        `NYSE 官方公告：美东 ${time} 提前收盘。`
      );
      e.source = NYSE_URL;
      if (events.has(day) && events.get(day)!.time !== time) throw new Error('NYSE 提前收盘时间冲突');
      events.set(day, e);
    }
  }
  if (!events.size) throw new Error('NYSE 提前收盘日历未识别');
  return { events: [...events.values()], years };
}

export function calendarSource(key: string): string {
  if (key.startsWith('market:') || key.startsWith('days:')) return 'Markets Open（CC BY 4.0）';
  if (key === 'weekly') return 'Forex Factory（本周）';
  if (key === 'official:fed') return '美联储官方日历';
  if (key === 'official:nyse') return 'NYSE 官方日历';
  if (key.startsWith('official:')) return 'BLS 官方日历';
  return 'Finance Calendar（旧缓存）';
}
