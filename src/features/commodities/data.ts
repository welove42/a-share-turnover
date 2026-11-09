import type { CommodityEntry, CommodityQuote, QuoteBatch } from '../../shared/types';
import { requestBuffer } from '../../core/network/http';
import { validDate } from '../turnover/market';

// Existing overseas series use Sina's CFD feed; domestic futures have a different schema and change baseline.
const CFD_ENTRIES: CommodityEntry[] = [
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
  ['SND', '伦敦锡', '美元/吨', '伦锡 LME Tin ldx'],
  ['NQ', '纳指100期货', '点', '纳斯达克100 纳斯达克指数期货 纳指期货 Nasdaq NAS100 ndx nz nq CFD']
].map(([code, name, unit, aliases]) => ({ code, name, unit, aliases, market: 'cfd' }));
const DOMESTIC_ENTRIES: CommodityEntry[] = [
  ['LC0', '碳酸锂主连', '元/吨', '碳酸锂连续 碳酸锂期货 LC tsl tansuanli 广期所'],
  ['LH0', '生猪主连', '元/吨', '生猪连续 生猪期货 LH sz shengzhu 大连商品交易所']
].map(([code, name, unit, aliases]) => ({ code, name, unit, aliases, market: 'domesticFutures' }));
const COMMODITIES: CommodityEntry[] = [...CFD_ENTRIES, ...DOMESTIC_ENTRIES];
const DEFAULT_COMMODITY_CODES = ['XAU', 'OIL', 'CAD', 'XAG'];
const DEFAULT_FUTURES_CODES = ['LC0', 'LH0', 'NQ'];
const isFuturesCode = (code: string): boolean => DEFAULT_FUTURES_CODES.includes(code);
const CATALOG = new Map(COMMODITIES.map((entry) => [entry.code, entry]));
function normalizeCommodityCodes(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,，;；]+/).filter(Boolean)
      : null;
  if (!values) throw new Error('商品列表必须是代码数组');
  const codes = [
    ...new Set(
      values.map((raw) => {
        if (typeof raw !== 'string') throw new Error('商品代码必须是字符串');
        const match = /^(?:(HF|NF)_)?([A-Z][A-Z0-9]*)$/.exec(raw.trim().toUpperCase());
        const symbol = match?.[2] || '';
        const code = symbol === 'LC' || symbol === 'LH' ? symbol + '0' : symbol;
        const entry = CATALOG.get(code);
        // Reject mismatched prefixes instead of silently routing a different market's symbol.
        if (!entry || (match?.[1] && match[1] !== (entry.market === 'domesticFutures' ? 'NF' : 'HF')))
          throw new Error(`未支持的商品或期货代码“${raw}”，请通过＋按名称或代码选择`);
        return code;
      })
    )
  ];
  return codes;
}
const entryFor = (code: string): CommodityEntry | undefined => CATALOG.get(code);
function number(raw: unknown): number | null {
  return typeof raw === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw))
    ? Number(raw)
    : null;
}
function isCommodityQuote(q: any): q is CommodityQuote {
  return Boolean(
    q &&
      CATALOG.has(q.code) &&
      Number.isFinite(q.price) &&
      typeof q.priceText === 'string' &&
      number(q.priceText) === q.price &&
      validDate(q.date) &&
      /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(q.time) &&
      q.timestamp === Date.parse(`${q.date}T${q.time}+08:00`) / 1000 &&
      ['previousClose', 'delta', 'percent', 'open', 'high', 'low'].every(
        (field) => q[field] === null || Number.isFinite(q[field])
      ) &&
      (CATALOG.get(q.code)?.market !== 'domesticFutures' ||
        (q.price > 0 &&
          q.previousClose === null &&
          ['previousSettlement', 'settlement', 'volume', 'openInterest'].every(
            (field) => q[field] === null || (Number.isFinite(q[field]) && q[field] >= 0)
          )))
  );
}
function parseCommodityQuotes(text: string, selected: string[]): QuoteBatch<CommodityQuote> {
  const codes = normalizeCommodityCodes(selected),
    wanted = new Set(codes),
    quotes = new Map<string, CommodityQuote>(),
    errors = new Map<string, string>();
  if (typeof text !== 'string') throw new Error('商品行情响应无效');
  // Parse quoted values only. Never evaluate JavaScript returned by the source.
  for (const match of text.matchAll(/(?:^|[\r\n])\s*var\s+hq_str_(hf|nf)_([A-Z][A-Z0-9]*)\s*=\s*"([^"\r\n]*)"\s*;/g)) {
    const code = match[2];
    if (!wanted.has(code)) continue;
    const domestic = CATALOG.get(code)!.market === 'domesticFutures';
    if (match[1] !== (domestic ? 'nf' : 'hf')) continue;
    const fields = match[3].split(','),
      price = number(fields[domestic ? 8 : 0]),
      previousClose = domestic ? null : number(fields[7]);
    // Sina's domestic page uses raw fields 8 (last) and 10 (previous settlement).
    // Field 9 is today's settlement, not the base for the displayed percentage.
    const positive = (raw: unknown) => {
      const value = number(raw);
      return value !== null && value > 0 ? value : null;
    };
    const previousSettlement = domestic ? positive(fields[10]) : null;
    const baseline = domestic ? previousSettlement : previousClose;
    const delta = price !== null && baseline !== null ? price - baseline : null;
    const date = fields[domestic ? 17 : 12];
    const time = domestic ? (fields[1] || '').replace(/^(\d{2})(\d{2})(\d{2})$/, '$1:$2:$3') : fields[6];
    const q = {
      code,
      price,
      priceText: fields[domestic ? 8 : 0],
      previousClose,
      delta,
      percent: delta !== null && baseline !== 0 ? (delta / Math.abs(baseline!)) * 100 : null,
      open: domestic ? positive(fields[2]) : number(fields[8]),
      high: domestic ? positive(fields[3]) : number(fields[4]),
      low: domestic ? positive(fields[4]) : number(fields[5]),
      date,
      time,
      timestamp: Date.parse(`${date}T${time}+08:00`) / 1000,
      ...(domestic
        ? {
            previousSettlement,
            settlement: positive(fields[9]),
            volume: number(fields[14]),
            openInterest: number(fields[13])
          }
        : {})
    };
    if (isCommodityQuote(q)) quotes.set(code, q);
    else errors.set(code, '价格或行情时间缺失，已保留上次报价');
  }
  for (const code of codes)
    if (!quotes.has(code) && !errors.has(code)) errors.set(code, '行情源未返回该商品，已保留上次报价');
  return { quotes, errors };
}
class CommodityProvider {
  declare request: typeof requestBuffer;

  constructor({ request = requestBuffer } = {}) {
    this.request = request;
  }
  async load(selected: string[], signal?: AbortSignal): Promise<QuoteBatch<CommodityQuote>> {
    const codes = normalizeCommodityCodes(selected);
    if (!codes.length) return { quotes: new Map(), errors: new Map() };
    const buffer = await this.request(
      `https://hq.sinajs.cn/list=${codes.map((code) => `${CATALOG.get(code)!.market === 'domesticFutures' ? 'nf' : 'hf'}_${code}`).join(',')}`,
      signal,
      { Referer: 'https://finance.sina.com.cn/' }
    );
    if (signal?.aborted) throw new Error('商品行情请求已取消');
    return parseCommodityQuotes(new TextDecoder('gb18030').decode(buffer), codes);
  }
}
function commodityUrl(code) {
  if (!CATALOG.has(code)) throw new Error('无效的商品代码');
  return `https://finance.sina.com.cn/futures/quotes/${code}.shtml`;
}
export {
  COMMODITIES,
  DEFAULT_COMMODITY_CODES,
  DEFAULT_FUTURES_CODES,
  isFuturesCode,
  entryFor,
  normalizeCommodityCodes,
  isCommodityQuote,
  parseCommodityQuotes,
  CommodityProvider,
  commodityUrl
};
