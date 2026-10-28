'use strict';
const { requestJson, requestBuffer } = require('./http');
const { validDate } = require('./market');

const REGIONS = [
  { id: 'asia', name: '亚洲', codes: ['N225', 'KS11', 'KOSPI200', 'HSI', 'HSCEI', 'HSAHP', 'HKEXT100', 'HKEXTN', 'HKEXTT', 'TWII', 'STI', 'FSTM', 'FSTAS', 'SENSEX', 'KLSE', 'SET', 'PSI', 'KSE100', 'VNINDEX', 'JKSE', 'CSEALL', 'XIN9', 'FISAULMU'] },
  { id: 'americas', name: '美洲', codes: ['NDX', 'NDX100', 'DJIA', 'SPX', 'TSX', 'BVSP', 'MXX'] },
  { id: 'europe', name: '欧洲', codes: ['FTSE', 'GDAXI', 'FCHI', 'SX5E', 'SXXP', 'MCX', 'NMX', 'ASX', 'AXX', 'RTS', 'IBEX', 'PSI20', 'OMXC20', 'BFX', 'AEX', 'WIG', 'OMXSPI', 'SSMI', 'HEX', 'HEX25', 'OSEBX', 'ATX', 'MIB', 'ASE', 'ICEXI', 'PX', 'ISEQ'] },
  { id: 'oceania', name: '大洋洲', codes: ['AS51', 'AORD', 'NZ50'] },
  { id: 'other', name: '跨市场 / 其他', codes: ['UDI', 'BDI', 'CRB'] }
];
const ALIASES = {
  N225: '日本 日经 Nikkei Japan', KS11: '韩国 KOSPI Korea 综合', KOSPI200: '韩国 Korea',
  NDX: '美国 美股 纳指 纳斯达克综合 Nasdaq Composite IXIC', NDX100: '美国 美股 纳指100 Nasdaq 100',
  DJIA: '美国 美股 道指 Dow Jones', SPX: '美国 美股 标普 S&P 500',
  HSI: '中国香港 港股 Hang Seng', TWII: '中国台湾 Taiwan',
  GDAXI: '德国 DAX', FTSE: '英国 FTSE', FCHI: '法国 CAC', AS51: '澳大利亚 Australia ASX 200'
};
const validId = id => typeof id === 'string' && /^100\.[A-Z][A-Z0-9]{0,19}$/.test(id);
function indexEntry(code, name) {
  const id = `100.${code}`;
  if (!validId(id) || typeof name !== 'string' || !name.trim() || name.length > 100 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('全球指数代码或名称无效');
  const region = REGIONS.find(item => item.codes.includes(code))?.id || 'other';
  return { id, code, name: name.trim(), region };
}
const DEFAULT_INDEX_IDS = ['100.NDX', '100.N225', '100.KS11'];
const BUILTIN_INDICES = [
  ['N225', '日经225'], ['KS11', '韩国KOSPI'], ['KOSPI200', '韩国KOSPI200'], ['HSI', '恒生指数'], ['TWII', '台湾加权'], ['STI', '富时新加坡海峡时报'], ['SENSEX', '印度孟买SENSEX'],
  ['NDX', '纳斯达克'], ['NDX100', '纳斯达克100'], ['DJIA', '道琼斯'], ['SPX', '标普500'], ['TSX', '加拿大S&P/TSX'],
  ['FTSE', '英国富时100'], ['GDAXI', '德国DAX'], ['FCHI', '法国CAC40'], ['SX5E', '欧洲斯托克50'],
  ['AS51', '澳大利亚标普200'], ['NZ50', '新西兰50'], ['UDI', '美元指数']
].map(([code, name]) => indexEntry(code, name));
function normalizeIndexIds(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，;；]+/).filter(Boolean) : null;
  if (!values) throw new Error('全球指数列表必须是代码数组');
  const ids = [...new Set(values.map(item => {
    if (typeof item !== 'string') throw new Error('指数代码必须是字符串');
    const code = item.trim().toUpperCase(), id = code.startsWith('100.') ? code : `100.${code}`;
    if (!validId(id)) throw new Error(`无效的指数代码“${item}”，例如 NDX、N225、KS11 或 100.SPX`);
    return id;
  }))];
  if (ids.length > 100) throw new Error('最多添加100个全球指数');
  return ids;
}
function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value))) return null;
  const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null;
}
function isGlobalQuote(q) {
  return q && validId(q.id) && q.id === `100.${q.code}` && typeof q.name === 'string' && q.name.length > 0 && q.name.length <= 100
    && REGIONS.some(region => region.id === q.region) && Number.isFinite(q.price) && q.price > 0
    && Number.isInteger(q.timestamp) && q.timestamp > 946684800 && q.timestamp < 4102444800
    && (!q.source || ['eastmoney', 'sina'].includes(q.source)) && (!q.timestampKind || ['quote', 'updated'].includes(q.timestampKind))
    && ['percent', 'delta', 'open', 'high', 'low', 'previousClose'].every(field => q[field] === null || Number.isFinite(q[field]));
}
function parsePage(payload) {
  const data = payload?.data;
  if (payload?.rc !== 0 || !data || !Number.isInteger(data.total) || data.total < 1 || data.total > 500 || !data.diff || typeof data.diff !== 'object') throw new Error('全球指数接口返回的数据无效');
  const rows = Array.isArray(data.diff) ? data.diff : Object.values(data.diff);
  if (!rows.length) throw new Error('全球指数接口返回了空列表');
  const entries = new Map(), quotes = new Map(), errors = new Map();
  for (const row of rows) {
    let entry;
    try { if (row?.f13 !== 100) continue; entry = indexEntry(row.f12, row.f14); } catch { continue; }
    entries.set(entry.id, entry);
    const q = { ...entry, source: 'eastmoney', timestampKind: 'quote', price: number(row.f2), percent: number(row.f3), delta: number(row.f4),
      open: number(row.f17), high: number(row.f15), low: number(row.f16), previousClose: number(row.f18), timestamp: number(row.f124) };
    if (isGlobalQuote(q)) quotes.set(entry.id, q);
    else errors.set(entry.id, '指数点位或行情时间缺失，已保留上次行情');
  }
  if (!entries.size) throw new Error('全球指数列表中没有可识别的指数');
  return { entries, quotes, errors, total: data.total };
}
const SINA_INDICES = {
  '100.N225': { symbol: 'b_NKY', name: /^日经225指数$/ },
  '100.KS11': { symbol: 'b_KOSPI', name: /^韩国KOSPI指数$/ },
  '100.NDX': { symbol: 'gb_$ixic', name: /^纳斯达克(?:综合指数)?$/ },
  '100.DJIA': { symbol: 'gb_$dji', name: /^道琼斯(?:工业平均指数)?$/ },
  '100.SPX': { symbol: 'gb_$inx', name: /^标普500指数$/ }
};
const SOURCE_COOLDOWN_MS = 5 * 60000;
function parseSinaIndices(text, ids) {
  const raw = new Map(), quotes = new Map();
  // Never execute the script response; only read explicitly mapped index symbols.
  for (const m of text.matchAll(/\bvar\s+hq_str_([A-Za-z0-9_$]+)\s*=\s*"([^"\r\n]*)"\s*;/g)) raw.set(m[1], m[2].split(','));
  for (const id of normalizeIndexIds(ids)) {
    const mapping = SINA_INDICES[id], f = raw.get(mapping?.symbol);
    if (!f || !mapping.name.test(f[0])) continue;
    const us = mapping.symbol.startsWith('gb_'), stamp = us ? f[3] : `${f[6]} ${f[7]}`;
    // b_* fields 4/5 are legacy display clocks without reliable dates. Fields
    // 6/7 give the source's dated update time; label it as such in the UI.
    if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(stamp) || !validDate(stamp.slice(0, 10))) continue;
    const entry = BUILTIN_INDICES.find(entry => entry.id === id);
    const q = { ...entry, source: 'sina', timestampKind: 'updated', price: number(f[1]), percent: number(f[us ? 2 : 3]), delta: number(f[us ? 4 : 2]),
      open: number(f[us ? 5 : 8]), previousClose: number(f[us ? 26 : 9]), high: number(f[us ? 6 : 10]), low: number(f[us ? 7 : 11]), timestamp: Date.parse(stamp.replace(' ', 'T') + '+08:00') / 1000 };
    if (isGlobalQuote(q)) quotes.set(id, q);
  }
  return quotes;
}
function parseSingleIndex(id, payload) {
  const d = payload?.data;
  if (payload?.rc !== 0 || !d || `100.${d.f57}` !== id || !Number.isInteger(d.f59) || d.f59 < 0 || d.f59 > 6) throw new Error('指数详情接口返回的数据无效');
  const scale = value => number(value) === null ? null : number(value) / 10 ** d.f59;
  const q = { ...indexEntry(d.f57, d.f58), source: 'eastmoney', timestampKind: 'quote', price: scale(d.f43), high: scale(d.f44), low: scale(d.f45), open: scale(d.f46), previousClose: scale(d.f60), delta: scale(d.f169), percent: number(d.f170) === null ? null : number(d.f170) / 100, timestamp: number(d.f86) };
  if (!isGlobalQuote(q)) throw new Error('指数点位或行情时间缺失');
  return q;
}
class GlobalIndexProvider {
  constructor({ request = requestJson, requestText = async (url, signal, headers) => new TextDecoder('gb18030').decode(await requestBuffer(url, signal, headers)), now = () => Date.now() } = {}) {
    this.request = request; this.requestText = requestText; this.now = now;
    this.batchRetryAt = 0; this.singleRetryAt = new Map();
  }
  async load(ids, signal) {
    ids = normalizeIndexIds(ids);
    const result = { entries: new Map(), quotes: new Map(), errors: new Map() };
    if (!ids.length) return result;
    const checkAbort = () => { if (signal?.aborted) throw new Error('请求已取消'); };
    const accept = q => {
      if (!isGlobalQuote(q) || q.timestamp * 1000 > this.now() + 300000) return false;
      result.quotes.set(q.id, q); result.entries.set(q.id, indexEntry(q.code, q.name)); result.errors.delete(q.id); return true;
    };
    checkAbort();
    if (this.now() >= this.batchRetryAt) {
      try {
        const params = new URLSearchParams({ fltt: '2', invt: '2', secids: ids.join(','), fields: 'f12,f14,f2,f3,f4,f13,f124,f17,f18,f15,f16' });
        const parsed = parsePage(await this.request(`https://push2.eastmoney.com/api/qt/ulist.np/get?${params}`, signal, { Referer: 'https://quote.eastmoney.com/' }));
        checkAbort();
        for (const id of ids) {
          const q = parsed.quotes.get(id);
          if (!q || !accept(q)) result.errors.set(id, parsed.errors.get(id) || '批量接口未返回有效报价');
        }
        if (!result.quotes.size) this.batchRetryAt = this.now() + SOURCE_COOLDOWN_MS;
      } catch (error) {
        checkAbort(); this.batchRetryAt = this.now() + SOURCE_COOLDOWN_MS;
        for (const id of ids) result.errors.set(id, `批量接口：${error.message}`);
      }
    }
    const backup = ids.filter(id => !result.quotes.has(id) && SINA_INDICES[id]);
    if (backup.length) {
      try {
        const text = await this.requestText(`https://hq.sinajs.cn/list=${backup.map(id => SINA_INDICES[id].symbol).join(',')}`, signal, { Referer: 'https://finance.sina.com.cn/' });
        checkAbort();
        const quotes = parseSinaIndices(text, backup);
        for (const id of backup) if (!quotes.has(id) || !accept(quotes.get(id))) result.errors.set(id, '备用源未返回有效指数报价或时间');
      } catch (error) { checkAbort(); for (const id of backup) result.errors.set(id, `备用源：${error.message}`); }
    }
    // Isolate individual failures. At most four detail requests are in flight;
    // failed symbols cool down independently instead of retrying every tick.
    const missing = ids.filter(id => !result.quotes.has(id) && this.now() >= (this.singleRetryAt.get(id) || 0)); let next = 0;
    const worker = async () => {
      while (next < missing.length) {
        checkAbort(); const id = missing[next++];
        try {
          const params = new URLSearchParams({ secid: id, fields: 'f43,f44,f45,f46,f57,f58,f59,f60,f86,f169,f170' });
          const q = parseSingleIndex(id, await this.request(`https://push2.eastmoney.com/api/qt/stock/get?${params}`, signal, { Referer: 'https://quote.eastmoney.com/' }));
          checkAbort(); if (!accept(q)) throw new Error('指数时间异常'); this.singleRetryAt.delete(id);
        } catch (error) { checkAbort(); this.singleRetryAt.set(id, this.now() + 60000); result.errors.set(id, `${result.errors.get(id) ? result.errors.get(id) + '；' : ''}逐项接口：${error.message}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker)); checkAbort();
    for (const id of ids) if (!result.quotes.has(id) && !result.errors.has(id)) result.errors.set(id, '行情连接暂不可用，稍后自动重试');
    return result;
  }
  async loadCatalog(signal) {
    const result = { entries: new Map(), quotes: new Map(), errors: new Map() };
    for (let page = 1; page <= 5; page++) {
      if (signal?.aborted) throw new Error('请求已取消');
      const params = new URLSearchParams({ pn: String(page), pz: '100', po: '0', np: '1', fltt: '2', invt: '2', fid: 'f12', fs: 'm:100', fields: 'f12,f14,f2,f3,f4,f13,f124,f17,f18,f15,f16' });
      const parsed = parsePage(await this.request(`https://push2.eastmoney.com/api/qt/clist/get?${params}`, signal, { Referer: 'https://quote.eastmoney.com/' }));
      if (signal?.aborted) throw new Error('请求已取消');
      for (const key of ['entries', 'quotes', 'errors']) for (const [id, value] of parsed[key]) result[key].set(id, value);
      if (result.entries.size >= parsed.total) return result;
    }
    throw new Error('全球指数列表不完整，请稍后刷新');
  }
}
function globalIndexUrl(id) {
  if (!validId(id)) throw new Error('无效的全球指数代码');
  return `https://quote.eastmoney.com/gb/zs${id.slice(4)}.html`;
}
module.exports = { REGIONS, ALIASES, DEFAULT_INDEX_IDS, BUILTIN_INDICES, normalizeIndexIds, validId, indexEntry, isGlobalQuote, parsePage, parseSinaIndices, parseSingleIndex, SOURCE_COOLDOWN_MS, GlobalIndexProvider, globalIndexUrl };
