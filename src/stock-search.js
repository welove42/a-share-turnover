'use strict';
const { requestQuoteText } = require('./http');
const { normalizeSymbol } = require('./quotes');
const { normalizeOverseas } = require('./overseas-symbols');

function parseSuggestions(text) {
  return parseMarketSuggestions(text).filter(item => item.market === 'a').map(({market, ...item}) => item);
}
function parseMarketSuggestions(text) {
  const match = typeof text === 'string' && text.match(/(?:var\s+)?v_hint\s*=\s*"([^"\r\n]*)"/);
  if (!match) throw new Error('股票搜索接口返回异常');
  const result = [], seen = new Set();
  // Tencent smartbox is a text protocol, never executable JavaScript.
  for (const row of match[1].split('^')) {
    const [market, code, rawName, pinyin, type] = row.split('~');
    if (!rawName) continue;
    let symbol, area;
    try {
      if (/^(sh|sz|bj)$/.test(market || '') && /^\d{6}$/.test(code || '')) { symbol = normalizeSymbol(market + code); area = 'a'; }
      else if ((market === 'hk' || market === 'us') && type === 'GP') { symbol = normalizeOverseas(code, market); area = market; }
      else continue;
    } catch { continue; }
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    result.push({ symbol, name: rawName.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).slice(0, 100), pinyin: (pinyin || '').slice(0, 100), type, market:area });
  }
  return result;
}
class StockSearch {
  constructor(request = requestQuoteText) { this.request = request; }
  async search(query, signal) {
    return parseSuggestions(await this.requestSuggestions(query, signal));
  }
  async searchAll(query, signal) {
    return parseMarketSuggestions(await this.requestSuggestions(query, signal));
  }
  async requestSuggestions(query, signal) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 60) throw new Error('请输入60字以内的股票名称或代码');
    const text = await this.request(`https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(query.trim())}&t=all`, signal);
    if (signal?.aborted) throw new Error('搜索已取消');
    return text;
  }
}
module.exports = { StockSearch, parseSuggestions, parseMarketSuggestions };
