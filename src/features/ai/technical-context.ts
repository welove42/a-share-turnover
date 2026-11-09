import type { PriceBar } from '../../shared/types';
import { calculate, movingAverage } from '../../shared/indicators';
import { pick } from './data';

export type Period = 'daily' | 'weekly' | 'monthly';
export interface ChartInput {
  bars: PriceBar[];
  date?: string;
  timestamp?: string;
  adjustment?: string;
  source?: string;
  previousClose?: number | null;
  etf?: unknown;
}
export const round = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(5)) : null;
const percent = (a: number, b: number) => (b > 0 ? round((a / b - 1) * 100) : null);
export const dayOf = (now: Date) => new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
const dateValid = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const week = (s: string) => {
  const d = new Date(s);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
/** 当前周/月统一视为形成中，避免把节假日、周中或月中的累计量当成完整周期。 */
export function forming(time: string, mode: Period, now: Date, timestamp?: string): boolean {
  const today = dayOf(now);
  if (mode === 'monthly') return time.slice(0, 7) === today.slice(0, 7);
  if (mode === 'weekly') return week(time) === week(today);
  return (
    time === today &&
    !(
      timestamp?.slice(0, 8) === today.replaceAll('-', '') &&
      /^\d{14}$/.test(timestamp) &&
      timestamp.slice(8) >= '150000' &&
      new Date(now.getTime() + 8 * 3600000).getUTCHours() >= 15
    )
  );
}
/** 拒绝错序/不合法整条序列，不能悄悄删掉异常K线后仍按“连续5日”计算。 */
export function cleanBars(chart: ChartInput, mode: Period, now: Date): PriceBar[] {
  if (!Array.isArray(chart?.bars)) return [];
  const today = dayOf(now);
  let prior = '';
  for (const b of chart.bars) {
    if (
      !dateValid(b.time) ||
      b.time <= prior ||
      !['open', 'high', 'low', 'close', 'volume'].every((k) => Number.isFinite(b[k])) ||
      b.volume < 0 ||
      b.high < Math.max(b.open, b.close) ||
      b.low > Math.min(b.open, b.close) ||
      (mode === 'daily'
        ? b.time > today
        : mode === 'weekly'
          ? week(b.time) > week(today)
          : b.time.slice(0, 7) > today.slice(0, 7))
    )
      return [];
    prior = b.time;
  }
  return chart.bars;
}
export function technical(bars: PriceBar[], mode: Period = 'daily') {
  const result: Record<string, any> = {},
    slopes: Record<string, number | null> = {};
  const periods = mode === 'monthly' ? [6, 12] : mode === 'weekly' ? [10, 20] : [5, 10, 20, 60, 120];
  for (const n of periods) {
    const values = movingAverage(bars, n),
      current = values.at(-1),
      previous = values.at(-4);
    result['MA' + n] = round(current);
    slopes['MA' + n] = current != null && previous != null ? round(current - previous) : null;
  }
  result.maChange3Bars = slopes;
  // EMA needs warm-up; a newly listed instrument must not receive apparently mature MACD signals.
  if (bars.length >= 35) {
    const m = calculate(bars, 'macd')!;
    result.macd = {
      DIF: round(m.lines[0].values.at(-1)),
      DEA: round(m.lines[1].values.at(-1)),
      histogram: round(m.histogram?.at(-1)),
      priorHistogram: round(m.histogram?.at(-2))
    };
  }
  if (bars.length >= 25)
    result.rsi = Object.fromEntries(calculate(bars, 'rsi')!.lines.map((l) => [l.name, round(l.values.at(-1))]));
  return result;
}
function range(bars: PriceBar[]) {
  if (!bars.length) return null;
  const high = bars.reduce((a, b) => (a.high >= b.high ? a : b)),
    low = bars.reduce((a, b) => (a.low <= b.low ? a : b));
  return {
    count: bars.length,
    from: bars[0].time,
    to: bars.at(-1)!.time,
    high: round(high.high)!,
    highDate: high.time,
    low: round(low.low)!,
    lowDate: low.time
  };
}
export function returnsOf(bars: PriceBar[], windows = [5, 20, 60]) {
  const last = bars.at(-1);
  return windows.flatMap((n) => {
    const first = bars.at(-n - 1);
    const change = last && first ? percent(last.close, first.close) : null;
    return change === null ? [] : [{ bars: n, from: first!.time, to: last!.time, percent: change }];
  });
}
/** 仅计算已完成周期的收益与量比，形成中的最新K单列，避免与全天/整周量比较。 */
export function summarizeChart(chart: ChartInput, mode: Period, now: Date) {
  const limit = { daily: 240, weekly: 120, monthly: 60 }[mode],
    all = cleanBars(chart, mode, now),
    bars = all.slice(-limit);
  if (!bars.length) return null;
  const latest = bars.at(-1)!,
    incomplete = forming(latest.time, mode, now, chart.timestamp),
    closed = incomplete ? bars.slice(0, -1) : bars;
  const end = closed.at(-1),
    base = closed.slice(-21, -1),
    avg = base.length === 20 ? base.reduce((s, b) => s + b.volume, 0) / 20 : null;
  const recent = closed.slice(-10),
    prior = closed.slice(-20, -10);
  const r = range(recent),
    p = range(prior);
  const ma = technical(closed, mode),
    pair = mode === 'monthly' ? [6, 12] : mode === 'weekly' ? [10, 20] : [20, 60];
  const direction =
    closed.length >= Math.max(20, pair[1] + 3) && r && p && end
      ? end.close > ma['MA' + pair[0]] &&
        end.close > ma['MA' + pair[1]] &&
        ma.maChange3Bars['MA' + pair[0]] > 0 &&
        ma.maChange3Bars['MA' + pair[1]] > 0 &&
        r.high > p.high &&
        r.low > p.low
        ? '偏强'
        : end.close < ma['MA' + pair[0]] &&
            end.close < ma['MA' + pair[1]] &&
            ma.maChange3Bars['MA' + pair[0]] < 0 &&
            ma.maChange3Bars['MA' + pair[1]] < 0 &&
            r.high < p.high &&
            r.low < p.low
          ? '偏弱'
          : '信号不一致 / 整理'
      : '样本不足';
  return {
    ...pick(chart, ['source', 'adjustment', 'timestamp']),
    date: latest.time,
    sample: { available: all.length, used: bars.length, closed: closed.length, from: bars[0].time, to: latest.time },
    state: direction,
    confirmedThrough: end?.time || null,
    forming: incomplete,
    indicators: ma,
    returns: returnsOf(closed, mode === 'monthly' ? [3, 6, 12] : mode === 'weekly' ? [4, 13, 26] : [5, 20, 60]),
    ranges: { recent10: r, prior10: p, prior20: range(closed.slice(-21, -1)), prior60: range(closed.slice(-61, -1)) },
    volumeUnit: '手',
    volume: { date: end?.time, ratioToPrior20: avg && end ? round(end.volume / avg) : null },
    bars: bars
      .slice(-3)
      .map((b) => pick(b, ['time', 'open', 'high', 'low', 'close', 'volume', 'amount', 'turnoverRate'])),
    ...(incomplete
      ? {
          developing: {
            ...pick(latest, ['time', 'open', 'high', 'low', 'close', 'volume']),
            indicators: technical(bars, mode)
          }
        }
      : {})
  };
}
function minute(time: string): string | null {
  const text = time.replace(/^.* /, '').replace(':', '');
  return /^(?:09[3-5]\d|10[0-5]\d|11(?:[0-2]\d|30)|13[0-5]\d|14[0-5]\d|1500)$/.test(text) ? text : null;
}
/** 五日分时压成每日摘要；同刻量比仅在各天都存在同一分钟时计算，不做时间插值。 */
export function summarizeIntraday(chart: ChartInput, now: Date) {
  if (!Array.isArray(chart?.bars)) return null;
  const groups = new Map<string, PriceBar[]>();
  for (const b of chart.bars) {
    const date = b.date || (b.time.includes(' ') ? b.time.slice(0, 10) : chart.date),
      time = minute(b.time);
    if (
      !date ||
      !dateValid(date) ||
      date > dayOf(now) ||
      !time ||
      !Number.isFinite(b.close) ||
      b.close <= 0 ||
      !Number.isFinite(b.volume) ||
      b.volume < 0
    )
      return null;
    const rows = groups.get(date) || [];
    if (rows.length && minute(rows.at(-1)!.time)! >= time) return null;
    rows.push(b);
    groups.set(date, rows);
  }
  const days = [...groups].sort(([a], [b]) => a.localeCompare(b)).slice(-5);
  if (!days.length) return null;
  const [date, rows] = days.at(-1)!,
    last = rows.at(-1)!,
    cutoff = minute(last.time)!;
  const total = (list: PriceBar[]) => list.reduce((s, b) => s + b.volume, 0);
  const prior = days.slice(0, -1).flatMap(([d, list]) => {
    const i = list.findIndex((b) => minute(b.time) === cutoff);
    return i < 0 ? [] : [{ date: d, volume: round(total(list.slice(0, i + 1))) }];
  });
  const average = prior.length ? prior.reduce((s, b) => s + b.volume!, 0) / prior.length : 0;
  const validAverage = (b: PriceBar) =>
    typeof b.averagePrice === 'number' && Number.isFinite(b.averagePrice) && b.averagePrice > 0;
  const withAverage = rows.filter(validAverage),
    vwap = validAverage(last) ? last.averagePrice! : null;
  const high = rows.reduce((a, b) => (a.close >= b.close ? a : b)),
    low = rows.reduce((a, b) => (a.close <= b.close ? a : b));
  // At most seven actual observations; keep first, last, extrema and representative intermediate points.
  const selected = [
    ...new Set([
      0,
      Math.floor((rows.length - 1) / 4),
      Math.floor((rows.length - 1) / 2),
      Math.floor((3 * (rows.length - 1)) / 4),
      rows.indexOf(high),
      rows.indexOf(low),
      rows.length - 1
    ])
  ].sort((a, b) => a - b);
  return {
    ...pick(chart, ['source', 'adjustment', 'timestamp']),
    date,
    time: cutoff,
    historical: date !== dayOf(now),
    samples: rows.length,
    price: round(last.close),
    averagePrice: round(vwap),
    aboveAverageFraction: withAverage.length
      ? round(withAverage.filter((b) => b.close >= b.averagePrice!).length / withAverage.length)
      : null,
    high: { price: high.close, time: minute(high.time) },
    low: { price: low.close, time: minute(low.time) },
    extremesScope: '分钟采样价极值，非逐笔最高最低',
    volumeUnit: '手',
    sameTimeVolume: {
      time: cutoff,
      current: round(total(rows)),
      previousDays: prior,
      ratioToPreviousMean: average > 0 ? round(total(rows) / average) : null
    },
    days: days.map(([day, list]) => ({
      date: day,
      lastTime: minute(list.at(-1)!.time),
      firstSample: list[0].close,
      last: list.at(-1)!.close,
      changeFromFirstSample: percent(list.at(-1)!.close, list[0].close),
      volume: round(total(list))
    })),
    points: selected.map((i) => ({
      time: minute(rows[i].time),
      price: round(rows[i].close),
      averagePrice: round(rows[i].averagePrice)
    }))
  };
}

export function comparableReturns(a: ReturnType<typeof returnsOf>, b: ReturnType<typeof returnsOf>) {
  return a.flatMap((x) => {
    const y = b.find((y) => y.bars === x.bars && y.from === x.from && y.to === x.to);
    return y ? [{ bars: x.bars, from: x.from, to: x.to, difference: round(x.percent! - y.percent!) }] : [];
  });
}
/** Only one copy of technical data goes to AI; UI/history keep their compatibility fields. */
export function analysisPayload(snapshot: import('./types').AnalysisSnapshot | null) {
  if (!snapshot) return null;
  const { coverage, daily, ...rest } = snapshot;
  // Keep market/news facts intact; only remove UI coverage and the duplicated daily compatibility alias.
  return { ...rest, ...(!rest.timeframes && daily ? { daily } : {}) };
}
