'use strict';
const { requestQuoteText } = require('./http');
const { normalizeSymbol } = require('./quotes');

function parseSuggestions(text) {
  const match = typeof text === 'string' && text.match(/(?:var\s+)?v_hint\s*=\s*"([^"\r\n]*)"/);
  if (!match) throw new Error('股票搜索接口返回异常');
  const result = [], seen = new Set();
  // Tencent smartbox is a text protocol, never executable JavaScript.
  for (const row of match[1].split('^')) {
    const [market, code, rawName, pinyin, type] = row.split('~');
    if (!/^(sh|sz|bj)$/.test(market || '') || !/^\d{6}$/.test(code || '') || !rawName) continue;
    const symbol = normalizeSymbol(market + code);
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    result.push({ symbol, name: rawName.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).slice(0, 100), pinyin: (pinyin || '').slice(0, 100), type });
  }
  return result;
}
class StockSearch {
  constructor(request = requestQuoteText) { this.request = request; }
  async search(query, signal) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 60) throw new Error('请输入60字以内的股票名称或代码');
    const text = await this.request(`https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(query.trim())}&t=all`, signal);
    if (signal?.aborted) throw new Error('搜索已取消');
    return parseSuggestions(text);
  }
}
module.exports = { StockSearch, parseSuggestions };
