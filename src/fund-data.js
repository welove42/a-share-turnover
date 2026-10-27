'use strict';
const { requestJson } = require('./http');
const { validDate } = require('./market');
const FUND_POLL_MS = 60000, MAX_FUNDS = 50;
function fundCode(value) {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) throw new Error('请输入六位基金代码，例如 110020；不要省略前导零');
  return value.trim();
}
function fundCodes(value) {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，;；]+/).filter(Boolean) : null;
  if (!parts) throw new Error('基金列表必须是代码数组');
  const codes = [...new Set(parts.map(fundCode))];
  if (codes.length > MAX_FUNDS) throw new Error(`最多添加${MAX_FUNDS}只基金`);
  return codes;
}
const plainText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[<>\x00-\x1f]/.test(value);
function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value))) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function parseFundSearch(payload) {
  if (payload?.ErrCode !== 0 || !Array.isArray(payload.Datas)) throw new Error('基金搜索接口返回的数据无效');
  const result = new Map();
  for (const row of payload.Datas) {
    if (row?.CATEGORY !== 700 || !/^\d{6}$/.test(row.CODE) || !plainText(row.NAME)) continue;
    result.set(row.CODE, { code: row.CODE, name: row.NAME.trim(), pinyin: plainText(row.JP) ? row.JP : '',
      type: plainText(row.FundBaseInfo?.FTYPE) ? row.FundBaseInfo.FTYPE : '基金' });
  }
  return [...result.values()];
}
function isFundQuote(q) {
  return Boolean(q && typeof q.code === 'string' && /^\d{6}$/.test(q.code) && plainText(q.name) && plainText(q.type) && validDate(q.date)
    && (q.kind === 'nav' ? Number.isFinite(q.nav) && q.nav > 0 && (q.percent === null || Number.isFinite(q.percent))
      && (q.cumulativeNav === null || Number.isFinite(q.cumulativeNav) && q.cumulativeNav >= 0)
      : q.kind === 'money' && Number.isFinite(q.incomePerUnit) && [100, 10000].includes(q.incomeUnit) && (q.sevenDayYield === null || Number.isFinite(q.sevenDayYield))));
}
function parseFundQuote(code, payload, metadata = {}) {
  code = fundCode(code);
  const data = payload?.Data, rows = data?.LSJZList;
  if (payload?.ErrCode !== 0 || !Array.isArray(rows) || !rows.length) throw new Error('尚无已公布基金净值，或基金代码不存在');
  const latest = rows[0];
  if (!validDate(latest.FSRQ)) throw new Error('基金净值日期无效');
  const q = { code, name: plainText(metadata.name) ? metadata.name : code, type: plainText(metadata.type) ? metadata.type : '基金', date: latest.FSRQ };
  if (data.FundType === '005' || /份收益/.test(data.SYType || '') || /货币/.test(metadata.type || '')) {
    const unit = { '每万份收益': 10000, '每百份收益': 100 }[data.SYType];
    if (!unit) throw new Error('该基金使用特殊收益口径，请在基金详情中查看');
    Object.assign(q, { kind: 'money', incomeUnit: unit, incomePerUnit: number(latest.DWJZ), sevenDayYield: number(latest.LJJZ) });
  } else {
    Object.assign(q, { kind: 'nav', nav: number(latest.DWJZ), percent: number(latest.JZZZL), cumulativeNav: number(latest.LJJZ) });
  }
  if (!isFundQuote(q)) throw new Error('基金净值或收益字段缺失，保留上次成功数据');
  return q;
}
function holdingPosition(value) {
  const parse = (raw, label) => {
    const text = typeof raw === 'string' ? raw.trim() : raw;
    const n = number(text);
    if (n === null || n <= 0 || n > 1e12) throw new Error(`${label}须为大于0且不超过1万亿的数字`);
    return n;
  };
  return { shares: parse(value?.shares, '持仓份额'), cost: parse(value?.cost, '持仓总成本') };
}
function holdingReturn(quote, position) {
  if (!isFundQuote(quote) || quote.kind !== 'nav' || !position) return null;
  let holding;
  try { holding = holdingPosition(position); } catch { return null; }
  const value = quote.nav * holding.shares, profit = value - holding.cost, rate = profit / holding.cost * 100;
  return [value, profit, rate].every(Number.isFinite) ? { ...holding, value, profit, rate, date: quote.date } : null;
}
class FundProvider {
  constructor({ request = requestJson } = {}) { this.request = request; this.metadata = new Map(); }
  async search(query, signal) {
    if (typeof query !== 'string' || !query.trim() || query.length > 100) return [];
    const payload = await this.request(`https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(query.trim())}`, signal, { Referer: 'https://fund.eastmoney.com/' });
    if (signal?.aborted) throw new Error('基金搜索已取消');
    const entries = parseFundSearch(payload); for (const entry of entries) this.metadata.set(entry.code, entry);
    return entries;
  }
  async loadOne(code, signal) {
    code = fundCode(code);
    const [metadata, payload] = await Promise.all([
      this.metadata.has(code) ? this.metadata.get(code) : this.search(code, signal).then(rows => rows.find(row => row.code === code)).catch(() => undefined),
      this.request(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=2`, signal, { Referer: 'https://fund.eastmoney.com/' })
    ]);
    if (signal?.aborted) throw new Error('基金请求已取消');
    return parseFundQuote(code, payload, metadata);
  }
  async load(values, signal) {
    const codes = fundCodes(values), quotes = new Map(), errors = new Map(); let next = 0;
    const worker = async () => {
      while (!signal?.aborted && next < codes.length) {
        const code = codes[next++];
        try { quotes.set(code, await this.loadOne(code, signal)); }
        catch (error) { errors.set(code, error.message || '基金净值获取失败'); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, codes.length) }, worker));
    if (signal?.aborted) throw new Error('基金请求已取消');
    return { quotes, errors };
  }
}
const fundUrl = code => `https://fund.eastmoney.com/${fundCode(code)}.html`;
module.exports = { FUND_POLL_MS, MAX_FUNDS, fundCode, fundCodes, parseFundSearch, parseFundQuote, isFundQuote, holdingPosition, holdingReturn, FundProvider, fundUrl };
