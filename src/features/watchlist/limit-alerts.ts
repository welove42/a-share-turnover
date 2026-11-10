import type { StockQuote } from '../../shared/types';

export type LimitEvent = 'limitUp' | 'limitDown' | 'limitUpOpened' | 'limitDownOpened';
export const LIMIT_EVENT_LABELS: Record<LimitEvent, string> = {
  limitUp: '涨停',
  limitDown: '跌停',
  limitUpOpened: '涨停炸板（打开涨停板）',
  limitDownOpened: '跌停炸板（打开跌停板）'
};
type LimitState = 'up' | 'down' | 'inside';
interface Observation {
  date: string;
  timestamp: number;
  observedAt: number;
  upper: number;
  lower: number;
  state: LimitState;
}
const MAX_GAP_MS = 120000;

/** A股最小价格单位为分；整数比较避免浮点误差把差一分钱误认为涨跌停。 */
function cents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) && Math.abs(value * 100 - result) < 0.00001 ? result : null;
}

function observation(q: StockQuote, now: number): Observation | null {
  // 股票白名单：排除指数、ETF、B股、债券、港美股；新股特殊简称不根据伪默认限价猜测。
  if (!/^(?:sh6\d{5}|sz(?:0\d{5}|30\d{4})|bj(?:[48]\d{5}|92\d{4}))$/.test(q.symbol) || /^[NC]/i.test(q.name))
    return null;
  if (q.securityType && !/^GP(?:-A(?:-[A-Z]+)?)?$/.test(q.securityType)) return null;
  const upper = cents(q.limitUp),
    lower = cents(q.limitDown),
    previous = cents(q.previousClose),
    price = cents(q.price);
  if (
    upper === null ||
    lower === null ||
    previous === null ||
    price === null ||
    lower >= previous ||
    upper <= previous ||
    price > upper ||
    price < lower
  )
    return null;
  // 源数据高低价已突破限价时，可能是不设限交易或字段异常，不能产生涨跌停事件。
  const high = cents(q.high),
    low = cents(q.low);
  if ((high !== null && high > upper) || (low !== null && low < lower)) return null;
  if (!/^\d{14}$/.test(q.timestamp) || q.timestamp.slice(0, 8) !== q.date.replaceAll('-', '')) return null;
  const hour = Number(q.timestamp.slice(8, 10)),
    minute = Number(q.timestamp.slice(10, 12)),
    second = Number(q.timestamp.slice(12));
  if (hour > 23 || minute > 59 || second > 59) return null;
  const tradingMinute = hour * 60 + minute;
  if (!((tradingMinute >= 570 && tradingMinute <= 690) || (tradingMinute >= 780 && tradingMinute <= 900))) return null;
  const timestamp = Date.parse(
    `${q.date}T${q.timestamp.slice(8, 10)}:${q.timestamp.slice(10, 12)}:${q.timestamp.slice(12)}+08:00`
  );
  if (
    !Number.isFinite(timestamp) ||
    now < timestamp ||
    now - timestamp > MAX_GAP_MS ||
    new Date(now + 8 * 3600000).toISOString().slice(0, 10) !== q.date
  )
    return null;
  return {
    date: q.date,
    timestamp,
    observedAt: now,
    upper,
    lower,
    state: price === upper ? 'up' : price === lower ? 'down' : 'inside'
  };
}

/** 仅在连续有效报价之间判断开板；不从当日最高/最低价追溯事件，也不跨重启恢复封板状态。 */
export class LimitAlertTracker {
  private states = new Map<string, Observation>();
  clear(symbol?: string): void {
    if (symbol) this.states.delete(symbol);
    else this.states.clear();
  }
  observe(q: StockQuote, now: number): LimitEvent[] {
    const current = observation(q, now);
    if (!current) {
      this.clear(q.symbol);
      return [];
    }
    let previous = this.states.get(q.symbol);
    if (previous && previous.date === current.date && current.timestamp <= previous.timestamp) return [];
    if (
      previous &&
      (previous.date !== current.date ||
        previous.upper !== current.upper ||
        previous.lower !== current.lower ||
        now - previous.observedAt > MAX_GAP_MS ||
        now < previous.observedAt ||
        current.timestamp - previous.timestamp > MAX_GAP_MS)
    )
      previous = undefined;
    this.states.set(q.symbol, current);
    const events: LimitEvent[] = [];
    if (previous?.state === 'up' && current.state !== 'up') events.push('limitUpOpened');
    if (previous?.state === 'down' && current.state !== 'down') events.push('limitDownOpened');
    if (current.state === 'up' && previous?.state !== 'up') events.push('limitUp');
    if (current.state === 'down' && previous?.state !== 'down') events.push('limitDown');
    return events;
  }
}
