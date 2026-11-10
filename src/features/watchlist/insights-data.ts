import { requestJson } from '../../core/network/http';
import { normalizeDate } from '../turnover/market';
import { getKlineFeed } from '../charts/kline-feed';

export interface DailySample {
  date: string;
  close: number;
  volume: number;
}
export interface ListHistory {
  bars: DailySample[];
  source: string;
  unit: '手' | '股';
}
export interface ListQuote {
  symbol: string;
  date: string;
  timestamp: string;
  price: number | null;
  volume?: number | null;
}
export interface ListHistoryProvider {
  load(symbol: string, signal: AbortSignal): Promise<ListHistory>;
}

export function quoteVolume(symbol: string, value: unknown): number | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // 腾讯科创板以股计，其他 A 股以手计；与图表口径保持一致。
  return /^sh68[89]\d{3}$/.test(symbol) ? n / 100 : n;
}

export function validHistory(value: unknown): value is ListHistory {
  const v = value as ListHistory;
  return Boolean(
    v &&
      ['手', '股'].includes(v.unit) &&
      typeof v.source === 'string' &&
      v.source.length < 100 &&
      Array.isArray(v.bars) &&
      v.bars.length > 0 &&
      v.bars.length <= 80 &&
      v.bars.every((b, i) => {
        try {
          return (
            b.date === normalizeDate(b.date.replaceAll('-', '')) &&
            Number.isFinite(b.close) &&
            b.close > 0 &&
            Number.isFinite(b.volume) &&
            b.volume >= 0 &&
            (!i || b.date > v.bars[i - 1].date)
          );
        } catch {
          return false;
        }
      })
  );
}

export class WatchlistHistoryProvider implements ListHistoryProvider {
  constructor(private request = requestJson) {}
  async load(symbol: string, signal: AbortSignal): Promise<ListHistory> {
    if (!/^(?:(?:sh|sz|bj)\d{6}|hk\d{5}|us[A-Z][A-Z0-9.]{0,14})$/.test(symbol)) throw new Error('自选代码无效');
    let data: ListHistory;
    if (symbol.startsWith('us')) {
      const ticker = symbol.slice(2).replaceAll('.', '-');
      const payload = await this.request(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`,
        signal,
        { Referer: 'https://finance.yahoo.com/', 'User-Agent': 'Mozilla/5.0' }
      );
      const r = payload?.chart?.result?.[0],
        quotes = r?.indicators?.quote?.[0],
        adjusted = r?.indicators?.adjclose?.[0]?.adjclose;
      if (payload?.chart?.error || r?.meta?.symbol?.toUpperCase() !== ticker || !Array.isArray(r?.timestamp) || !quotes)
        throw new Error('美股历史日线暂不可用');
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const bars: DailySample[] = [];
      r.timestamp.forEach((stamp: number, i: number) => {
        // Yahoo 的空行表示缺失，不可当作零成交量；采用复权收盘价避免拆股造成假趋势。
        if (quotes.close?.[i] == null || quotes.volume?.[i] == null) return;
        const parts = Object.fromEntries(formatter.formatToParts(new Date(stamp * 1000)).map((p) => [p.type, p.value]));
        bars.push({
          date: `${parts.year}-${parts.month}-${parts.day}`,
          close: adjusted?.[i] ?? quotes.close[i],
          volume: quotes.volume[i]
        });
      });
      data = { bars: bars.slice(-40), source: 'Yahoo Finance 日线', unit: '股' };
    } else {
      const result = await getKlineFeed(this.request).load(symbol, 'daily', signal, { priority: 2 });
      // 列表已有独立旧缓存；共享源返回过期数据时不能把它保存成今天新取得的均量基准。
      if (result.stale) throw new Error('历史数据暂未更新');
      const p = result.payload;
      const d = p?.code === 0 && p.data?.[symbol],
        rows = d?.qfqday || d?.day;
      if (!Array.isArray(rows)) throw new Error('历史日线暂不可用');
      data = {
        bars: rows.slice(-40).map((row) => {
          if (
            !Array.isArray(row) ||
            row.length < 6 ||
            String(row[2]).trim() === '' ||
            quoteVolume(symbol, row[5]) === null
          )
            throw new Error('历史日线字段不完整');
          return {
            date: normalizeDate(String(row[0]).replaceAll('-', '')),
            close: Number(row[2]),
            volume: quoteVolume(symbol, row[5])!
          };
        }),
        source: result.source + (d.qfqday ? '前复权日线' : '不复权日线'),
        unit: symbol.startsWith('hk') ? '股' : '手'
      };
    }
    if (signal.aborted) throw new Error('历史查询已取消');
    if (!validHistory(data)) throw new Error('历史日线数据无效');
    return data;
  }
}

/** 盘中用交易进度折算，包含午休分段；不是历史同一时刻的真实量比。 */
export function volumeProgress(timestamp: string, market: 'a' | 'hk' | 'us') {
  const minute = Number(timestamp.slice(8, 10)) * 60 + Number(timestamp.slice(10, 12));
  if (market === 'us') return { elapsed: Math.max(0, Math.min(390, minute - 570)), total: 390, closed: minute >= 960 };
  const morning = market === 'hk' ? 150 : 120,
    end = market === 'hk' ? 960 : 900;
  return {
    elapsed: Math.max(0, Math.min(morning, minute - 570)) + Math.max(0, Math.min(end - 780, minute - 780)),
    total: morning + end - 780,
    closed: minute >= end
  };
}

export function listMetrics(q: ListQuote, history: ListHistory, market: 'a' | 'hk' | 'us') {
  if (q.price === null || !Number.isFinite(q.price) || q.price <= 0 || q.volume === 0)
    return { missing: '停牌或暂无有效成交，暂不判断趋势与量能' };
  const past = history.bars.filter((b) => b.date < q.date);
  const last = past.at(-1);
  if (!last || Date.parse(q.date) - Date.parse(last.date) > 20 * 86400000)
    return { missing: '历史数据过旧或没有完整交易日' };
  const trend =
    past.length >= 10 && q.price !== null && q.price > 0
      ? (() => {
          const mean = (rows: number[]) => rows.reduce((a, b) => a + b, 0) / rows.length;
          const prices = [...past.map((b) => b.close), q.price!];
          const ma5 = mean(prices.slice(-5)),
            ma10 = mean(prices.slice(-10)),
            previous5 = mean(past.slice(-5).map((b) => b.close));
          const label =
            q.price! > ma5 && ma5 > ma10 && ma5 > previous5
              ? '短线偏强'
              : q.price! < ma5 && ma5 < ma10 && ma5 < previous5
                ? '短线偏弱'
                : '短线整理';
          return { label, ma5, ma10, previous5 };
        })()
      : undefined;
  const previous = past.slice(-7);
  const average = previous.length === 7 ? previous.reduce((s, b) => s + b.volume, 0) / 7 : null;
  const current = q.volume;
  const progress = volumeProgress(q.timestamp, market);
  // 美股半日市不能套用390分钟预测；常规盘中仅显示实际累计比例。
  const estimated = market !== 'us' && !progress.closed;
  const ready = average !== null && average > 0 && current != null && Number.isFinite(current) && current >= 0;
  const actualRatio = ready ? current! / average! : null;
  const ratio =
    ready && (progress.closed || (estimated && progress.elapsed >= 15))
      ? actualRatio! * (estimated ? progress.total / progress.elapsed : 1)
      : null;
  const label = ratio === null ? undefined : ratio > 1.2 ? '放量' : ratio < 0.8 ? '缩量' : '平量';
  return { trend, average, previous, actualRatio, ratio, label, estimated, progress };
}
