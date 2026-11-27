import type { MarketBreadth, TurnoverSnapshot } from '../../shared/types';
import { normalizeDate, timeToMinute, tradingMinute } from '../turnover/market';

export type TemperatureDisplayMode = 'temperature' | 'breadth';
export interface BreadthData {
  counts: MarketBreadth | null;
  total: number | null;
  date: string | null;
  time: string | null;
  status: 'live' | 'snapshot' | 'cached' | 'paused' | 'unavailable';
  label: string;
}

/** 家数独立于温度评分：缺少昨日同刻基准、处于开盘观察期时仍可展示有效家数。 */
export function marketBreadth(
  snapshot: TurnoverSnapshot | null,
  state: { paused?: boolean; cached?: boolean; error?: string },
  clock: { date: string; minute: number; polling: boolean; phase: string },
  now: Date
): BreadthData {
  const unavailable = (label: string): BreadthData => ({
    counts: null,
    total: null,
    date: null,
    time: null,
    status: 'unavailable',
    label
  });
  if (!snapshot) return unavailable('等待沪深涨跌家数');
  const markets = ['sh000002', 'sz399107'].map((symbol) => snapshot.markets?.find((m) => m.symbol === symbol));
  const minutes: number[] = [];
  for (const market of markets) {
    const counts = market?.breadth;
    if (
      !counts ||
      ![counts.advancing, counts.declining, counts.unchanged].every(
        (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000
      ) ||
      counts.advancing + counts.declining + counts.unchanged < 100 ||
      !/^\d{14}$/.test(market!.timestamp || '')
    )
      return unavailable('缺少完整的沪深涨跌家数或报价时间');
    try {
      if (normalizeDate(market!.timestamp.slice(0, 8)) !== snapshot.date || Number(market!.timestamp.slice(12)) > 59)
        throw new Error();
      const minute = timeToMinute(market!.timestamp.slice(8, 12));
      if (minute < 570 || snapshot.date > clock.date || (snapshot.date === clock.date && minute > clock.minute + 1))
        throw new Error();
      minutes.push(minute);
    } catch {
      return unavailable('涨跌家数的行情时间无效');
    }
  }
  const counts: MarketBreadth = {
    advancing: markets.reduce((sum, m) => sum + m!.breadth!.advancing, 0),
    declining: markets.reduce((sum, m) => sum + m!.breadth!.declining, 0),
    unchanged: markets.reduce((sum, m) => sum + m!.breadth!.unchanged, 0)
  };
  if (snapshot.additionalBreadth) {
    counts.advancing += snapshot.additionalBreadth.advancing;
    counts.declining += snapshot.additionalBreadth.declining;
    counts.unchanged += snapshot.additionalBreadth.unchanged;
  }
  const total = counts.advancing + counts.declining + counts.unchanged;
  if (total < 1000) return unavailable('涨跌家数覆盖不足');
  const age = now.getTime() - Date.parse(snapshot.fetchedAt);
  const quoteMinutes = minutes.map(tradingMinute);
  const stale =
    snapshot.date !== clock.date ||
    state.cached ||
    state.error ||
    !Number.isFinite(age) ||
    age < -30000 ||
    (clock.polling && age > 90000) ||
    Math.max(...quoteMinutes) - Math.min(...quoteMinutes) > 2 ||
    (clock.polling && tradingMinute(clock.minute) - Math.min(...quoteMinutes) > 2);
  // 失败、重载或暂停时保留完整家数，但明确标记快照，不冒充实时数据。
  const status = state.paused ? 'paused' : stale ? 'cached' : clock.polling ? 'live' : 'snapshot';
  return {
    counts,
    total,
    date: snapshot.date,
    time: markets.map((m) => m!.timestamp.slice(8).replace(/(..)(..)(..)/, '$1:$2:$3')).sort()[0],
    status,
    label:
      status === 'paused'
        ? '已暂停 · 保留最近行情'
        : status === 'cached'
          ? '历史 / 缓存行情'
          : snapshot.additionalBreadth
            ? '沪深北 A 股涨跌家数'
            : '沪深 A 股涨跌家数（北交所待更新）'
  };
}
