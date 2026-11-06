import type { StockQuote } from '../../shared/types';
import { StockProvider, supportsTurnover } from '../watchlist/quotes';
import { requestJson } from '../../core/network/http';
import { attempt, abortError } from './data';
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
function parseQuotes(payload, symbols: string[], now = Date.now()) {
  if (payload?.rc !== 0 || !payload.data?.diff) throw new Error('备用报价不可用');
  const wanted = new Map(symbols.map((s) => [`${s.startsWith('sh') ? 1 : 0}.${s.slice(2)}`, s])),
    quotes = new Map<string, StockQuote>();
  for (const row of Object.values<Record<string, any>>(payload.data.diff)) {
    const symbol = wanted.get(`${row.f13}.${row.f12}`),
      price = number(row.f2),
      time = number(row.f124);
    if (
      !symbol ||
      price === null ||
      time === null ||
      !(price > 0) ||
      !(time > 946684800) ||
      time * 1000 > now + 300000 ||
      typeof row.f14 !== 'string' ||
      !row.f14.trim()
    )
      continue;
    const beijing = new Date(time * 1000 + 8 * 3600000).toISOString();
    quotes.set(symbol, {
      symbol,
      name: row.f14.slice(0, 100),
      price,
      priceText: String(price),
      previousClose: number(row.f18),
      percent: number(row.f3),
      delta: number(row.f4),
      high: number(row.f15),
      low: number(row.f16),
      turnoverRate: supportsTurnover(symbol) ? number(row.f8) : null,
      date: beijing.slice(0, 10),
      timestamp: beijing.slice(0, 19).replace(/[-:T]/g, ''),
      source: '东方财富'
    });
  }
  return quotes;
}
class AiQuoteProvider {
  declare primary: any;
  declare request: any;
  declare now: any;

  constructor({ primary = new StockProvider(), request = requestJson, now = () => Date.now() } = {}) {
    Object.assign(this, { primary, request, now });
  }
  async load(symbols, signal?: AbortSignal) {
    let result;
    try {
      result = await this.primary.load(symbols, signal);
    } catch {
      if (signal?.aborted) throw abortError();
      result = { quotes: new Map(), errors: new Map() };
    }
    if (signal?.aborted) throw abortError();
    const missing = symbols.filter((s) => !result.quotes.has(s));
    if (!missing.length) return result;
    const query = new URLSearchParams({
      secids: missing.map((s) => `${s.startsWith('sh') ? 1 : 0}.${s.slice(2)}`).join(','),
      fltt: '2',
      fields: 'f12,f13,f14,f2,f3,f4,f18,f15,f16,f8,f124'
    });
    const backup = await attempt(
      (s) =>
        this.request(`https://push2.eastmoney.com/api/qt/ulist.np/get?${query}`, s, {
          Referer: 'https://quote.eastmoney.com/'
        }),
      signal,
      6000
    );
    if (backup.ok) {
      try {
        for (const [symbol, quote] of parseQuotes(backup.value, missing, this.now())) {
          result.quotes.set(symbol, quote);
          result.errors?.delete(symbol);
        }
      } catch {
        /* Preserve primary quotes. */
      }
    }
    return result;
  }
}
export { AiQuoteProvider, parseQuotes };
