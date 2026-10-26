'use strict';
const { requestQuoteText } = require('./http');
const { normalizeDate, timeToMinute } = require('./market');

const MAX_STOCKS = 100;
const INDEX_SYMBOL = 'sh000001';
function normalizeSymbol(value) {
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
function normalizeSymbols(value) {
  const tokens = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，;；]+/).filter(Boolean) : [];
  const symbols = [...new Set(tokens.map(normalizeSymbol))];
  if (symbols.length > MAX_STOCKS) throw new Error(`最多支持 ${MAX_STOCKS} 个自选代码`);
  return symbols;
}
function signedNumber(value) {
  if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function parseQuotes(text, symbols) {
  const wanted = new Set(symbols);
  const quotes = new Map();
  const errors = new Map();
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
      const delta = trading ? signedNumber(q[31]) ?? (previousClose > 0 ? price - previousClose : null) : null;
      const percent = trading ? signedNumber(q[32]) ?? (previousClose > 0 ? (price / previousClose - 1) * 100 : null) : null;
      quotes.set(symbol, {
        symbol, name: q[1].slice(0, 100), price: trading ? price : null,
        priceText: trading ? q[3] : '—', previousClose, delta, percent,
        date, timestamp: q[30], high: signedNumber(q[33]), low: signedNumber(q[34])
      });
    } catch (error) { errors.set(symbol, error.message); }
  }
  for (const symbol of symbols) if (!quotes.has(symbol) && !errors.has(symbol)) errors.set(symbol, '未查询到行情，请检查代码是否存在或已更名');
  return { quotes, errors };
}
function isQuote(q) {
  try {
    return q && normalizeSymbol(q.symbol) === q.symbol && typeof q.name === 'string'
      && (q.price === null || (Number.isFinite(q.price) && q.price > 0))
      && typeof q.priceText === 'string' && /^(?:\d+(?:\.\d+)?|—)$/.test(q.priceText)
      && [q.percent, q.delta, q.high, q.low].every(v => v === null || Number.isFinite(v))
      && /^\d{14}$/.test(q.timestamp) && normalizeDate(q.timestamp.slice(0, 8)) === q.date;
  } catch { return false; }
}
function signed(value, precision = 2) {
  return value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(precision)}`;
}
function percentText(value) { return value === null ? '—' : signed(value) + '%'; }
function orderedSymbols(symbols, quotes, sortBy) {
  if (sortBy !== 'percentDesc' && sortBy !== 'percentAsc') return [...symbols];
  return [...symbols].sort((a, b) => {
    const left = quotes.get(a)?.percent, right = quotes.get(b)?.percent;
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    return sortBy === 'percentDesc' ? right - left : left - right;
  });
}
class StockProvider {
  constructor(request = requestQuoteText) { this.request = request; }
  async load(symbols, signal) {
    const all = [...new Set(symbols.map(normalizeSymbol))];
    const quotes = new Map(), errors = new Map();
    const batches = [];
    for (let i = 0; i < all.length; i += 50) batches.push(all.slice(i, i + 50));
    await Promise.all(batches.map(async batch => {
      try {
        const text = await this.request(`https://qt.gtimg.cn/q=${batch.join(',')}`, signal);
        const result = parseQuotes(text, batch);
        for (const [symbol, q] of result.quotes) quotes.set(symbol, q);
        for (const [symbol, error] of result.errors) errors.set(symbol, error);
      } catch (error) { for (const symbol of batch) errors.set(symbol, error.message || '行情请求失败'); }
    }));
    if (signal?.aborted) throw new Error('行情请求已取消');
    return { quotes, errors };
  }
}
module.exports = { MAX_STOCKS, INDEX_SYMBOL, normalizeSymbol, normalizeSymbols, parseQuotes, isQuote, signed, percentText, orderedSymbols, StockProvider };
