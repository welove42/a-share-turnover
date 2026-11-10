import type { StockQuote, QuoteBatch } from '../../shared/types';
import { requestQuoteText } from '../../core/network/http';
import { normalizeDate, timeToMinute } from '../turnover/market';
import { parseEtfQuote } from '../funds/etf-quote';
import { quoteVolume } from './insights-data';

const MAX_STOCKS = 100;
const INDEX_SYMBOL = 'sh000001';
function normalizeSymbol(value: unknown): string {
  if (typeof value !== 'string') throw new Error('股票代码必须是字符串');
  const input = value.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(input)) return input;
  const suffix = input.match(/^(\d{6})\.(sh|sz|bj)$/);
  if (suffix) return suffix[2] + suffix[1];
  if (/^[56]\d{5}$/.test(input)) return 'sh' + input;
  if (/^[013]\d{5}$/.test(input)) return 'sz' + input;
  if (/^(?:[48]\d{5}|92\d{4})$/.test(input)) return 'bj' + input;
  throw new Error(`无法识别代码“${value}”，请输入六位代码或 sh600519 / sz000001 / bj920002`);
}
function normalizeSymbols(value: unknown): string[] {
  const tokens = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,，;；]+/).filter(Boolean)
      : [];
  const symbols = [...new Set(tokens.map(normalizeSymbol))];
  if (symbols.length > MAX_STOCKS) throw new Error(`最多支持 ${MAX_STOCKS} 个自选代码`);
  return symbols;
}
function signedNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function supportsTurnover(symbol: string): boolean {
  return !/^sz399\d{3}$/.test(symbol) && /^(?:sh6\d{5}|sz[03]\d{5}|bj\d{6})$/.test(symbol);
}
function turnoverRate(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : signedNumber(value);
  return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function dailyExtremes(high: unknown, low: unknown) {
  const positive = (value: unknown) => {
    const result = turnoverRate(value);
    return result !== null && result > 0 ? result : null;
  };
  const dailyHigh = positive(high),
    dailyLow = positive(low);
  return dailyHigh !== null && dailyLow !== null && dailyHigh < dailyLow
    ? { dailyHigh: null, dailyLow: null }
    : { dailyHigh, dailyLow };
}
function parseQuotes(text: string, symbols: string[]): QuoteBatch {
  const wanted = new Set(symbols);
  const quotes = new Map<string, StockQuote>();
  const errors = new Map<string, string>();
  // Parse as text. Never eval a provider response.
  for (const match of text.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"\r\n]*)"\s*;?/g)) {
    const symbol = match[1];
    if (!wanted.has(symbol)) continue;
    try {
      const q = match[2].split('~');
      if (!q[1] || q[2] !== symbol.slice(2) || !/^\d{14}$/.test(q[30] || '')) throw new Error('行情字段不完整');
      const date = normalizeDate(q[30].slice(0, 8));
      timeToMinute(q[30].slice(8, 12));
      if (Number(q[30].slice(12, 14)) > 59) throw new Error('行情时间无效');
      const price = signedNumber(q[3]);
      const previousClose = signedNumber(q[4]);
      if (price === null || price < 0 || previousClose === null || previousClose < 0) throw new Error('价格字段无效');
      const trading = price > 0;
      const delta = trading ? (signedNumber(q[31]) ?? (previousClose > 0 ? price - previousClose : null)) : null;
      const percent = trading
        ? (signedNumber(q[32]) ?? (previousClose > 0 ? (price / previousClose - 1) * 100 : null))
        : null;
      quotes.set(symbol, {
        symbol,
        name: q[1].slice(0, 100),
        price: trading ? price : null,
        priceText: trading ? q[3] : '—',
        previousClose,
        delta,
        percent,
        date,
        timestamp: q[30],
        high: signedNumber(q[33]),
        volume: quoteVolume(symbol, q[6]),
        low: signedNumber(q[34]),
        turnoverRate: supportsTurnover(symbol) ? turnoverRate(q[38]) : null,
        limitUp: signedNumber(q[47]),
        limitDown: signedNumber(q[48]),
        securityType: q[61] || '',
        ...(q[61] === 'ETF' ? { etf: parseEtfQuote(symbol, q) } : {})
      });
    } catch (error) {
      errors.set(symbol, error.message);
    }
  }
  for (const symbol of symbols)
    if (!quotes.has(symbol) && !errors.has(symbol)) errors.set(symbol, '未查询到行情，请检查代码是否存在或已更名');
  return { quotes, errors };
}
function isQuote(q: any): q is StockQuote {
  try {
    return (
      q &&
      normalizeSymbol(q.symbol) === q.symbol &&
      typeof q.name === 'string' &&
      (q.price === null || (Number.isFinite(q.price) && q.price > 0)) &&
      typeof q.priceText === 'string' &&
      /^(?:\d+(?:\.\d+)?|—)$/.test(q.priceText) &&
      [q.percent, q.delta, q.high, q.low].every((v) => v === null || Number.isFinite(v)) &&
      /^\d{14}$/.test(q.timestamp) &&
      normalizeDate(q.timestamp.slice(0, 8)) === q.date
    );
  } catch {
    return false;
  }
}
function signed(value: number | null, precision = 2): string {
  return value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(precision)}`;
}
function percentText(value: number | null): string {
  return value === null ? '—' : signed(value) + '%';
}
function orderedSymbols(
  symbols: string[],
  quotes: ReadonlyMap<string, Pick<StockQuote, 'percent'>>,
  sortBy: string
): string[] {
  if (sortBy !== 'percentDesc' && sortBy !== 'percentAsc') return [...symbols];
  return [...symbols].sort((a, b) => {
    const left = quotes.get(a)?.percent,
      right = quotes.get(b)?.percent;
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    return sortBy === 'percentDesc' ? right - left : left - right;
  });
}
class StockProvider {
  declare request: typeof requestQuoteText;

  constructor(request = requestQuoteText) {
    this.request = request;
  }
  async load(symbols: string[], signal?: AbortSignal): Promise<QuoteBatch> {
    const all = [...new Set(symbols.map(normalizeSymbol))];
    const quotes = new Map<string, StockQuote>(),
      errors = new Map<string, string>();
    const batches: string[][] = [];
    for (let i = 0; i < all.length; i += 50) batches.push(all.slice(i, i + 50));
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const text = await this.request(`https://qt.gtimg.cn/q=${batch.join(',')}`, signal);
          const result = parseQuotes(text, batch);
          for (const [symbol, q] of result.quotes) quotes.set(symbol, q);
          for (const [symbol, error] of result.errors) errors.set(symbol, error);
        } catch (error) {
          for (const symbol of batch) errors.set(symbol, error.message || '行情请求失败');
        }
      })
    );
    if (signal?.aborted) throw new Error('行情请求已取消');
    return { quotes, errors };
  }
}
export {
  MAX_STOCKS,
  INDEX_SYMBOL,
  normalizeSymbol,
  normalizeSymbols,
  parseQuotes,
  isQuote,
  signed,
  percentText,
  orderedSymbols,
  supportsTurnover,
  turnoverRate,
  dailyExtremes,
  StockProvider
};
