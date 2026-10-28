'use strict';

// Calendar source: https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
const HOLIDAY_RANGES = [
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07']
];
const POLL_MS = 10000;

function shanghaiClock(now = new Date()) {
  // UTC+8 has no DST. Never depend on the host timezone.
  const shifted = new Date(now.getTime() + 8 * 3600000);
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 19),
    weekday: shifted.getUTCDay(),
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

function isClosedDate(clock, extra = []) {
  return clock.weekday === 0 || clock.weekday === 6 || extra.includes(clock.date)
    || HOLIDAY_RANGES.some(([start, end]) => clock.date >= start && clock.date <= end);
}

function session(now = new Date(), extra = []) {
  const clock = shanghaiClock(now);
  let phase;
  if (isClosedDate(clock, extra)) phase = 'closed';
  else if (clock.minute < 570) phase = 'before';
  else if (clock.minute < 690) phase = 'trading';
  else if (clock.minute < 780) phase = 'lunch';
  else if (clock.minute < 900) phase = 'trading';
  else if (clock.minute < 902) phase = 'settling';
  else phase = 'after';
  return { ...clock, phase, polling: phase === 'trading' || phase === 'settling' };
}

const PHASE_LABELS = {
  closed: '休市', before: '盘前', trading: '交易中', lunch: '午休',
  settling: '收盘确认', after: '已收盘', auction: '集合竞价', opening: '待开盘'
};

// Stock quotes update during the opening auction; turnover minute charts start at 09:30.
function stockSession(now = new Date(), extra = []) {
  const clock = session(now, extra);
  if (clock.phase === 'before' && clock.minute >= 555) {
    return { ...clock, phase: clock.minute < 565 ? 'auction' : 'opening', polling: true };
  }
  return clock;
}

function numeric(value, label) {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
    throw new Error(`${label}缺失`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}无效`);
  return number;
}

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

function normalizeDate(raw) {
  if (typeof raw !== 'string' || !/^\d{8}$/.test(raw)) throw new Error('行情日期格式错误');
  const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (!validDate(date)) throw new Error('行情日期无效');
  return date;
}

function timeToMinute(time) {
  if (!/^\d{4}$/.test(time)) throw new Error('分时字段格式错误');
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2));
  if (hour > 23 || minute > 59) throw new Error('分时字段无效');
  return hour * 60 + minute;
}

function tradingMinute(minute) {
  return Math.max(0, Math.min(120, minute - 570)) + Math.max(0, Math.min(120, minute - 780));
}

function stockTradingMinute(minute) {
  // The 09:25 auction result can remain unchanged until continuous trading begins.
  return Math.max(0, Math.min(10, minute - 555)) + tradingMinute(minute);
}

function parsePoints(rows) {
  if (!Array.isArray(rows)) throw new Error('缺少分时列表');
  const points = [];
  for (const row of rows) {
    if (typeof row !== 'string') throw new Error('分时行情格式变化');
    const fields = row.trim().split(/\s+/);
    if (fields.length < 4) throw new Error('分时成交额字段缺失');
    const minute = timeToMinute(fields[0]);
    if (!((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900))) continue;
    const point = { time: fields[0], amount: numeric(fields[3], '分时成交额') };
    const last = points.at(-1);
    if (last && (point.time <= last.time || point.amount + 1 < last.amount)) {
      throw new Error('分时累计成交额顺序异常');
    }
    points.push(point);
  }
  return points;
}

function payloadData(payload, symbol) {
  if (payload?.code !== 0 || !payload?.data?.[symbol]) throw new Error(`${symbol}行情接口返回异常`);
  return payload.data[symbol];
}

function parseBreadth(values) {
  // Tencent's own index page labels qt.zhishu[2]/[3]/[4] as rising/flat/falling.
  // Missing optional breadth must not interrupt the existing turnover feed.
  if (!Array.isArray(values)) return null;
  const counts = [values[2], values[3], values[4]].map(value =>
    (typeof value === 'string' && /^\d+$/.test(value)) || typeof value === 'number' ? Number(value) : NaN);
  if (!counts.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100000)) return null;
  const [advancing, unchanged, declining] = counts;
  return advancing + unchanged + declining > 0 ? { advancing, unchanged, declining } : null;
}

function parseMinute(payload, symbol) {
  const data = payloadData(payload, symbol);
  const quote = data.qt?.[symbol];
  if (!Array.isArray(quote) || !/^\d{14}$/.test(quote[30] || '')) throw new Error(`${symbol}实时行情字段异常`);
  const date = normalizeDate(quote[30].slice(0, 8));
  const dateOfPoints = normalizeDate(data.data?.date);
  if (date !== dateOfPoints) throw new Error(`${symbol}实时行情和分时日期不一致`);
  timeToMinute(quote[30].slice(8, 12));
  if (Number(quote[30].slice(12, 14)) > 59) throw new Error('行情秒数无效');
  // Tencent's index quote[35] = price / volume(hands) / amount(yuan).
  // Use its yuan field, not the rounded ten-thousand-yuan field at quote[37].
  const detail = typeof quote[35] === 'string' ? quote[35].split('/') : [];
  if (detail.length !== 3) throw new Error(`${symbol}实时成交额字段缺失`);
  return {
    symbol, date, timestamp: quote[30], amount: numeric(detail[2], '实时成交额'),
    points: parsePoints(data.data?.data), breadth: parseBreadth(data.qt?.zhishu),
    percent: Number(quote[3]) > 0 && Number(quote[4]) > 0 && Number.isFinite(Number(quote[3])) && Number.isFinite(Number(quote[4]))
      ? (Number(quote[3]) / Number(quote[4]) - 1) * 100 : null
  };
}

function parseHistory(payload, symbol) {
  const rows = payloadData(payload, symbol).data;
  if (!Array.isArray(rows)) throw new Error(`${symbol}历史分时缺失`);
  const days = rows.map(row => ({ date: normalizeDate(row.date), points: parsePoints(row.data) }));
  if (new Set(days.map(day => day.date)).size !== days.length) throw new Error('历史行情日期重复');
  return days;
}

function change(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current < 0 || previous <= 0) return null;
  return { current, previous, delta: current - previous, percent: (current / previous - 1) * 100 };
}

function minuteLabel(time) { return `${time.slice(0, 2)}:${time.slice(2)}`; }

function buildSnapshot(markets, histories, fetchedAt = new Date()) {
  if (markets.length !== 2 || markets[0].date !== markets[1].date) throw new Error('沪深行情日期不一致，已保留上次数据');
  const date = markets[0].date;
  const snapshot = {
    version: 1, date, fetchedAt: fetchedAt.toISOString(),
    amount: markets.reduce((sum, market) => sum + market.amount, 0),
    markets: markets.map(({ symbol, amount, timestamp, breadth, percent }) => ({ symbol, amount, timestamp, breadth: breadth || null, percent: percent ?? null })),
    previousDate: null, sameTime: null, previousDay: null, comparisonTime: null,
    warning: ''
  };
  const priorDates = histories.flatMap(days => (days || []).map(day => day.date))
    .filter(day => day < date).sort();
  const previousDate = priorDates.at(-1);
  const previous = histories.map(days => days?.find(day => day.date === previousDate));
  if (!previousDate || histories.some(days => !days?.some(day => day.date === date))
    || previous.some(day => !day || day.points.at(-1)?.time !== '1500')) {
    snapshot.warning = '缺少两市同一上一交易日的完整分时数据';
    return snapshot;
  }
  snapshot.previousDate = previousDate;
  const previousTotal = previous.reduce((sum, day) => sum + day.points.at(-1).amount, 0);
  snapshot.previousDay = change(snapshot.amount, previousTotal);

  const quoteMinute = Math.min(...markets.map(market => timeToMinute(market.timestamp.slice(8, 12))));
  const currentMaps = markets.map(market => new Map(market.points.map(point => [point.time, point.amount])));
  const time = markets[0].points.map(point => point.time).filter(t => currentMaps[1].has(t)
    && timeToMinute(t) <= quoteMinute).at(-1);
  if (!time || tradingMinute(quoteMinute) - tradingMinute(timeToMinute(time)) > 2) {
    snapshot.warning = '当前分时尚未更新，同刻比较暂不可用';
    return snapshot;
  }
  const previousPoints = previous.map(day => day.points.find(point => point.time === time));
  if (previousPoints.some(point => !point)) {
    snapshot.warning = `上一交易日 ${minuteLabel(time)} 分时缺失，同刻比较暂不可用`;
    return snapshot;
  }
  snapshot.comparisonTime = minuteLabel(time);
  snapshot.sameTime = change(currentMaps[0].get(time) + currentMaps[1].get(time),
    previousPoints[0].amount + previousPoints[1].amount);
  if (!snapshot.sameTime || !snapshot.previousDay) snapshot.warning = '比较基准为零，无法计算缩放量';
  return snapshot;
}

function isSnapshot(value) {
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const comparison = c => c === null || (c && ['current', 'previous', 'delta', 'percent'].every(k => finite(c[k]))
    && c.current >= 0 && c.previous > 0);
  return value?.version === 1 && validDate(value.date) && finite(value.amount) && value.amount >= 0
    && typeof value.fetchedAt === 'string' && Number.isFinite(Date.parse(value.fetchedAt))
    && Array.isArray(value.markets) && value.markets.length === 2
    && ['sh000002', 'sz399107'].every((symbol, i) => value.markets[i]?.symbol === symbol
      && finite(value.markets[i].amount) && /^\d{14}$/.test(value.markets[i].timestamp))
    && (value.previousDate === null || validDate(value.previousDate))
    && comparison(value.sameTime) && comparison(value.previousDay)
    && (value.comparisonTime === null || /^\d{2}:\d{2}$/.test(value.comparisonTime))
    && typeof value.warning === 'string';
}

module.exports = {
  POLL_MS, PHASE_LABELS, shanghaiClock, session, numeric, validDate, normalizeDate, timeToMinute,
  tradingMinute, stockSession, stockTradingMinute, parsePoints, parseMinute, parseHistory, change, minuteLabel, buildSnapshot, isSnapshot, parseBreadth
};
