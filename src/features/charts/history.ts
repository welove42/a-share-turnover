import type { PriceBar } from '../../shared/types';

export const MAX_HISTORY_BARS = 16000;
export const supportsHistory = (mode: string): boolean => ['daily', 'weekly', 'monthly'].includes(mode);
interface Series {
  symbol: string;
  mode: string;
  adjustment: string;
  bars: PriceBar[];
  historyComplete?: boolean;
  sourceId?: string;
  klineFetchedAt?: number;
}
export function periodKey(time: string, mode: string): string {
  if (mode === 'monthly') return time.slice(0, 7);
  if (mode === 'weekly') {
    const d = new Date(time.slice(0, 10) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return time;
}
const samePrice = (a: PriceBar, b: PriceBar) =>
  ['open', 'close', 'high', 'low'].every((key) => Math.abs(a[key] - b[key]) < 0.00001);

/** Validate the overlapping boundary; do not splice different securities, periods or adjustment bases. */
export function prependHistory<T extends Series>(current: T, older: Series): T {
  if (current.symbol !== older.symbol || current.mode !== older.mode) throw new Error('历史行情与当前图表不匹配');
  if (current.sourceId !== older.sourceId) throw new Error('历史数据来源发生变化，请刷新图表后重试，避免混合不同来源');
  if (!older.bars.length) return { ...current, historyComplete: true };
  if (current.adjustment !== older.adjustment) throw new Error('历史复权口径发生变化，请刷新图表后重试');
  const first = current.bars[0];
  if (older.bars.some((bar) => bar.time > first.time)) throw new Error('历史接口返回了错误的日期范围');
  const overlap = older.bars.find((bar) => bar.time === first.time);
  if (overlap && !samePrice(first, overlap)) throw new Error('历史复权价格已更新，请刷新图表后重试');
  const added = older.bars.filter((bar) => bar.time < first.time);
  if (current.bars.length + added.length > MAX_HISTORY_BARS) throw new Error('历史记录达到容量上限，请按时间分段查看');
  return { ...current, bars: [...added, ...current.bars], historyComplete: !added.length };
}

/** Refresh recent bars while retaining older history and already fetched turnover fields. */
export function retainHistory<T extends Series>(
  previous: T | null | undefined,
  fresh: T
): T & { historyReset?: boolean } {
  if (!previous || !supportsHistory(fresh.mode) || previous.symbol !== fresh.symbol || previous.mode !== fresh.mode)
    return fresh;
  // 同一份历史缓存不能覆盖已经用实时报价更新的当前K线，否则每10秒会先倒退再恢复。
  if (
    previous.sourceId &&
    previous.sourceId === fresh.sourceId &&
    Number.isFinite(previous.klineFetchedAt) &&
    previous.klineFetchedAt === fresh.klineFetchedAt
  ) {
    const retained: any = { ...fresh, ...previous };
    for (const key of ['source', 'klineStale', 'klineWarning', 'historicalStatus']) retained[key] = fresh[key];
    return retained;
  }
  const old = new Map(previous.bars.map((bar) => [bar.time, bar]));
  const changed =
    previous.sourceId !== fresh.sourceId ||
    previous.adjustment !== fresh.adjustment ||
    fresh.bars.slice(0, -1).some((bar) => old.has(bar.time) && !samePrice(old.get(bar.time)!, bar));
  if (changed) return { ...fresh, historyComplete: false, historyReset: true };
  // 部分来源以最近交易日标记正在形成的周/月K；日期推进后替换同一周期，不能多出一根。
  const periods = new Set(fresh.bars.map((bar) => periodKey(bar.time, fresh.mode)));
  const dates = new Set(fresh.bars.map((bar) => bar.time));
  for (const [time] of old) if (periods.has(periodKey(time, fresh.mode)) && !dates.has(time)) old.delete(time);
  for (const bar of fresh.bars) old.set(bar.time, { ...old.get(bar.time), ...bar });
  return {
    ...fresh,
    bars: [...old.values()].sort((a, b) => a.time.localeCompare(b.time)),
    historyComplete: previous.historyComplete
  };
}
