import { requestJson } from '../../core/network/http';
import { abortError } from './data';
import type { ChartInput } from './technical-context';
import { cleanBars } from './technical-context';

/** 行业/全球指数的历史日K；缓存只节流主动分析，失败时保留原数据日期。 */
export class AiHistoryProvider {
  private cache = new Map<string, { at: number; chart: ChartInput }>();
  constructor(
    private request = requestJson,
    private now = () => Date.now()
  ) {}
  async load(secid: string, signal?: AbortSignal): Promise<ChartInput & { cached: boolean; fetchedAt: string }> {
    if (signal?.aborted) throw abortError();
    if (!/^(?:90\.BK\d{4}|100\.[A-Z0-9]{2,20})$/.test(secid)) throw new Error('历史指数代码无效');
    const old = this.cache.get(secid),
      now = this.now();
    if (old && now >= old.at && now - old.at < 10 * 60000)
      return { ...old.chart, cached: true, fetchedAt: new Date(old.at).toISOString() };
    try {
      const query = new URLSearchParams({
        secid,
        klt: '101',
        fqt: '0',
        lmt: '80',
        end: '20500101',
        fields1: 'f1,f2,f3,f4,f5,f6',
        fields2: 'f51,f52,f53,f54,f55,f56'
      });
      const payload = await this.request(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${query}`, signal);
      if (signal?.aborted) throw abortError();
      if (payload?.rc !== 0 || payload.data?.code !== secid.split('.')[1] || !Array.isArray(payload.data.klines))
        throw new Error('历史指数数据不匹配');
      const bars = payload.data.klines.slice(-80).map((row: unknown) => {
        if (typeof row !== 'string') throw new Error('历史指数格式异常');
        const [time, ...raw] = row.split(',');
        if (raw.length < 5 || raw.slice(0, 5).some((v) => !v.trim() || !Number.isFinite(Number(v))))
          throw new Error('历史指数数值缺失');
        const [open, close, high, low, volume] = raw.map(Number);
        return { time, open, close, high, low, volume };
      });
      if (!bars.length) throw new Error('历史指数为空');
      const chart = { bars, source: '东方财富历史日K', adjustment: '不复权', date: bars.at(-1)!.time };
      if (!cleanBars(chart, 'daily', new Date(now)).length) throw new Error('历史指数价格或日期异常');
      this.cache.set(secid, { at: now, chart });
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
      return { ...chart, cached: false, fetchedAt: new Date(now).toISOString() };
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (old && now >= old.at && now - old.at < 7 * 86400000)
        return { ...old.chart, cached: true, fetchedAt: new Date(old.at).toISOString() };
      throw error;
    }
  }
}
