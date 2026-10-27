'use strict';
const { requestJson } = require('./http');

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
    const q = { ...entry, price: number(row.f2), percent: number(row.f3), delta: number(row.f4),
      open: number(row.f17), high: number(row.f15), low: number(row.f16), previousClose: number(row.f18), timestamp: number(row.f124) };
    if (isGlobalQuote(q)) quotes.set(entry.id, q);
    else errors.set(entry.id, '指数点位或行情时间缺失，已保留上次行情');
  }
  if (!entries.size) throw new Error('全球指数列表中没有可识别的指数');
  return { entries, quotes, errors, total: data.total };
}
class GlobalIndexProvider {
  constructor({ request = requestJson } = {}) { this.request = request; }
  async load(signal) {
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
module.exports = { REGIONS, ALIASES, DEFAULT_INDEX_IDS, BUILTIN_INDICES, normalizeIndexIds, validId, indexEntry, isGlobalQuote, parsePage, GlobalIndexProvider, globalIndexUrl };
