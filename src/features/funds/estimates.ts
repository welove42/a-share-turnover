import { requestJson } from '../../core/network/http';
import { validDate, shanghaiClock, tradingMinute } from '../turnover/market';

const HOSTS = ['fundcomapi.eastmoney.com', 'fundcomapi.tiantianfunds.com'];
const FIELDS = 'FCODE,SHORTNAME,GSZZL,GZTIME,GSZ,NAV,PDATE';
const validTime = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(value) &&
  validDate(value.slice(0, 10));
const numeric = (value) =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : NaN;

function isFundEstimate(e) {
  return Boolean(
    e &&
      typeof e.code === 'string' &&
      /^\d{6}$/.test(e.code) &&
      typeof e.name === 'string' &&
      e.name.trim().length > 0 &&
      e.name.length <= 200 &&
      !/[<>\x00-\x1f]/.test(e.name) &&
      validTime(e.time) &&
      validDate(e.baseDate) &&
      e.baseDate < e.time.slice(0, 10) &&
      Number.isFinite(e.nav) &&
      e.nav > 0 &&
      Number.isFinite(e.baseNav) &&
      e.baseNav > 0 &&
      Number.isFinite(e.percent) &&
      e.percent > -100 &&
      Math.abs((e.nav / e.baseNav - 1) * 100 - e.percent) <= Math.max(0.05, (0.00011 / e.baseNav) * 100) &&
      HOSTS.includes(e.sourceHost)
  );
}

function parseFundEstimates(payload, codes, sourceHost = HOSTS[0]) {
  if (payload?.success !== true || payload.errorCode !== 0 || !Array.isArray(payload.data))
    throw new Error('基金估值接口返回的数据无效');
  const estimates = new Map(),
    unavailable = new Set(),
    errors = new Map(),
    seen = new Set(),
    requested = new Set(codes);
  for (const row of payload.data) {
    if (!row || typeof row.FCODE !== 'string' || !requested.has(row.FCODE)) continue;
    const code = row.FCODE;
    if (seen.has(code)) {
      estimates.delete(code);
      unavailable.delete(code);
      errors.set(code, '基金估值返回重复代码');
      continue;
    }
    seen.add(code);
    if ([row.GSZ, row.GSZZL, row.GZTIME].every((v) => v === null)) {
      unavailable.add(code);
      continue;
    }
    const e = {
      code,
      name: row.SHORTNAME,
      nav: numeric(row.GSZ),
      percent: numeric(row.GSZZL),
      time: row.GZTIME,
      baseNav: numeric(row.NAV),
      baseDate: row.PDATE,
      sourceHost
    };
    if (isFundEstimate(e)) estimates.set(code, e);
    else errors.set(code, '基金估值字段或基准净值异常');
  }
  for (const code of codes) if (!seen.has(code)) errors.set(code, '估值接口未返回该基金');
  return { estimates, unavailable, errors };
}

// Use only today's estimates based on the same published NAV. Lunch and the
// close do not age otherwise recent estimates by hours of non-trading time.
function estimateReason(e, quote, now) {
  if (!e || !isFundEstimate(e)) return '暂无盘中估算';
  const clock = shanghaiClock(now),
    date = e.time.slice(0, 10);
  if (quote?.kind !== 'nav' || quote.code !== e.code) return '缺少可核对的正式净值';
  if (quote.date >= date) return '对应日期的正式净值已公布';
  if (date !== clock.date) return '估算不是今日数据';
  if (Date.parse(e.time.replace(' ', 'T') + ':00+08:00') > now.getTime() + 120000) return '估算时间异常';
  if (quote.date !== e.baseDate || Math.abs(quote.nav - e.baseNav) > 0.00011) return '估算基准与正式净值不一致';
  const minute = Number(e.time.slice(11, 13)) * 60 + Number(e.time.slice(14, 16));
  if (minute < 570 || minute > 930 || tradingMinute(clock.minute) - tradingMinute(minute) > 15)
    return '估算已超过15个交易分钟未更新';
  return '';
}

class FundEstimateProvider {
  declare request: typeof requestJson;
  declare preferredHost: string;

  constructor({ request = requestJson } = {}) {
    this.request = request;
    this.preferredHost = HOSTS[0];
  }
  async load(codes, signal?: AbortSignal) {
    if (
      !Array.isArray(codes) ||
      codes.length > 50 ||
      codes.some((code) => typeof code !== 'string' || !/^\d{6}$/.test(code))
    )
      throw new Error('基金估值代码无效');
    if (!codes.length) return { estimates: new Map(), unavailable: new Set(), errors: new Map() };
    const args = new URLSearchParams({ FCODES: [...new Set(codes)].join(','), FIELDS });
    let lastError;
    for (const host of [this.preferredHost, ...HOSTS.filter((host) => host !== this.preferredHost)]) {
      if (signal?.aborted) throw new Error('基金估值请求已取消');
      try {
        const data = await this.request(`https://${host}/mm/newCore/FundValuationLast?${args}`, signal, {
          Referer: 'https://h5.1234567.com.cn/'
        });
        if (signal?.aborted) throw new Error('基金估值请求已取消');
        const result = parseFundEstimates(data, codes, host);
        this.preferredHost = host;
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    if (signal?.aborted) throw new Error('基金估值请求已取消');
    throw new Error('盘中估算暂不可用：' + (lastError?.message || '请求失败'));
  }
}
export { isFundEstimate, parseFundEstimates, estimateReason, FundEstimateProvider };
