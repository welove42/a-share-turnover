import type { StockQuote } from '../../shared/types';
import { periodKey, supportsHistory } from './history';
import { normalizeDate, timeToMinute } from '../turnover/market';

/** 只重建当前未结束周期；历史部分保持原来源，周/月成交量从完整日线汇总，不能反复累加当日量。 */
export function withLiveQuote<
  T extends { symbol: string; mode: string; sourceId?: string; bars: any[]; date?: string; [key: string]: any }
>(series: T, q: StockQuote, daily: T = series): T {
  if (
    !supportsHistory(series.mode) ||
    !series.bars.length ||
    series.symbol !== q.symbol ||
    daily.sourceId !== series.sourceId ||
    !/^\d{14}$/.test(q.timestamp) ||
    q.timestamp.slice(8, 12) < '0930' ||
    q.price == null ||
    q.price <= 0 ||
    q.open == null ||
    q.open <= 0 ||
    q.volume == null ||
    !Number.isFinite(q.volume) ||
    q.volume < 0 ||
    q.high == null ||
    q.low == null ||
    q.low <= 0 ||
    q.high < Math.max(q.open, q.price) ||
    q.low > Math.min(q.open, q.price)
  )
    return series;
  try {
    if (normalizeDate(q.timestamp.slice(0, 8)) !== q.date || Number(q.timestamp.slice(12)) > 59) return series;
    timeToMinute(q.timestamp.slice(8, 12));
  } catch {
    return series;
  }
  const lastDay = daily.bars.at(-1);
  // 周/月汇总必须已有当天日线；缺少中间交易日时不能把不完整的累计量覆盖完整周期。
  if (
    !lastDay ||
    lastDay.time > q.date ||
    (series.mode !== 'daily' && lastDay.time !== q.date) ||
    (lastDay.time === q.date && q.volume < lastDay.volume)
  )
    return series;
  const key = periodKey(q.date, series.mode),
    last = series.bars.at(-1)!;
  if (key < periodKey(last.time, series.mode) || (series.timestamp && q.timestamp < series.timestamp)) return series;
  const previous =
    series.mode === 'daily' ? [] : daily.bars.filter((b) => periodKey(b.time, series.mode) === key && b.time < q.date);
  const bar = {
    time: q.date,
    open: q.open,
    close: q.price,
    high: q.high,
    low: q.low,
    volume: q.volume,
    amount: q.amount ?? null,
    historicalTurnover: q.turnoverRate ?? null
  };
  const days = [...previous, bar];
  const sum = (field: string) =>
    days.every((b) => b[field] != null && Number.isFinite(b[field])) ? days.reduce((n, b) => n + b[field], 0) : null;
  const current = {
    ...bar,
    open: days[0].open,
    high: Math.max(...days.map((b) => b.high)),
    low: Math.min(...days.map((b) => b.low)),
    volume: sum('volume'),
    amount: sum('amount'),
    historicalTurnover: sum('historicalTurnover')
  };
  if (current.volume === null) return series;
  return {
    ...series,
    bars: [...series.bars.filter((b) => periodKey(b.time, series.mode) !== key), current],
    date: q.date,
    timestamp: q.timestamp,
    previousClose: q.previousClose,
    dailyHigh: q.high,
    dailyLow: q.low,
    dailyQuoteTimestamp: q.timestamp,
    turnoverRate: q.turnoverRate,
    turnoverTimestamp: q.timestamp
  };
}
