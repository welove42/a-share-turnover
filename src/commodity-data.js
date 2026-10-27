'use strict';
const { requestBuffer } = require('./http');
const { validDate } = require('./market');

// These are Sina's named CFD reference series, not exchange order-book feeds.
const COMMODITIES = [
  ['XAU', '伦敦金', '美元/盎司', '现货黄金 Gold ldj 黄金/美元'],
  ['OIL', '布伦特原油', '美元/桶', '布油 Brent bly 原油'],
  ['CAD', '伦敦铜', '美元/吨', '伦铜 LME Copper ldt'],
  ['XAG', '伦敦银', '美元/盎司', '现货白银 Silver ldy 白银/美元'],
  ['CL', '纽约原油', '美元/桶', '美原油 WTI nyyy'],
  ['NG', '美国天然气', '美元/百万英热单位', '天然气 Natural Gas trq'],
  ['GC', '纽约黄金', '美元/盎司', '美黄金 COMEX Gold nyhj'],
  ['SI', '纽约白银', '美元/盎司', '美白银 COMEX Silver nyby'],
  ['HG', '纽约铜', '美分/磅', '美铜 COMEX Copper nyt'],
  ['AHD', '伦敦铝', '美元/吨', '伦铝 LME Aluminium ldl'],
  ['ZSD', '伦敦锌', '美元/吨', '伦锌 LME Zinc ldx'],
  ['NID', '伦敦镍', '美元/吨', '伦镍 LME Nickel ldn'],
  ['PBD', '伦敦铅', '美元/吨', '伦铅 LME Lead ldq'],
  ['SND', '伦敦锡', '美元/吨', '伦锡 LME Tin ldx']
].map(([code, name, unit, aliases]) => ({ code, name, unit, aliases }));
const DEFAULT_COMMODITY_CODES = ['XAU', 'OIL', 'CAD', 'XAG'];
const CATALOG = new Map(COMMODITIES.map(entry => [entry.code, entry]));
function normalizeCommodityCodes(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，;；]+/).filter(Boolean) : null;
  if (!values) throw new Error('商品列表必须是代码数组');
  const codes = [...new Set(values.map(raw => {
    if (typeof raw !== 'string') throw new Error('商品代码必须是字符串');
    const code = raw.trim().toUpperCase().replace(/^HF_/, '');
    if (!CATALOG.has(code)) throw new Error(`未支持的商品代码“${raw}”，请通过＋按名称或代码选择商品`);
    return code;
  }))];
  return codes;
}
const entryFor = code => CATALOG.get(code);
function number(raw) {
  return typeof raw === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : null;
}
function isCommodityQuote(q) {
  return Boolean(q && CATALOG.has(q.code) && Number.isFinite(q.price) && typeof q.priceText === 'string'
    && number(q.priceText) === q.price && validDate(q.date) && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(q.time)
    && q.timestamp === Date.parse(`${q.date}T${q.time}+08:00`) / 1000
    && ['previousClose', 'delta', 'percent', 'open', 'high', 'low'].every(field => q[field] === null || Number.isFinite(q[field])));
}
function parseCommodityQuotes(text, selected) {
  const codes = normalizeCommodityCodes(selected), wanted = new Set(codes), quotes = new Map(), errors = new Map();
  if (typeof text !== 'string') throw new Error('商品行情响应无效');
  // Parse quoted values only. Never evaluate JavaScript returned by the source.
  for (const match of text.matchAll(/(?:^|[\r\n])\s*var\s+hq_str_hf_([A-Z]+)\s*=\s*"([^"\r\n]*)"\s*;/g)) {
    const code = match[1]; if (!wanted.has(code)) continue;
    const fields = match[2].split(','), price = number(fields[0]), previousClose = number(fields[7]);
    const delta = price !== null && previousClose !== null ? price - previousClose : null;
    const q = { code, price, priceText: fields[0], previousClose, delta,
      percent: delta !== null && previousClose !== 0 ? delta / Math.abs(previousClose) * 100 : null,
      open: number(fields[8]), high: number(fields[4]), low: number(fields[5]), date: fields[12], time: fields[6],
      timestamp: Date.parse(`${fields[12]}T${fields[6]}+08:00`) / 1000 };
    if (isCommodityQuote(q)) quotes.set(code, q);
    else errors.set(code, '价格或行情时间缺失，已保留上次报价');
  }
  for (const code of codes) if (!quotes.has(code) && !errors.has(code)) errors.set(code, '行情源未返回该商品，已保留上次报价');
  return { quotes, errors };
}
class CommodityProvider {
  constructor({ request = requestBuffer } = {}) { this.request = request; }
  async load(selected, signal) {
    const codes = normalizeCommodityCodes(selected);
    if (!codes.length) return { quotes: new Map(), errors: new Map() };
    const buffer = await this.request(`https://hq.sinajs.cn/list=${codes.map(code => `hf_${code}`).join(',')}`, signal, { Referer: 'https://finance.sina.com.cn/' });
    if (signal?.aborted) throw new Error('商品行情请求已取消');
    return parseCommodityQuotes(new TextDecoder('gb18030').decode(buffer), codes);
  }
}
function commodityUrl(code) {
  if (!CATALOG.has(code)) throw new Error('无效的商品代码');
  return `https://finance.sina.com.cn/futures/quotes/${code}.shtml`;
}
module.exports = { COMMODITIES, DEFAULT_COMMODITY_CODES, entryFor, normalizeCommodityCodes, isCommodityQuote, parseCommodityQuotes, CommodityProvider, commodityUrl };
