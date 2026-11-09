import type { EtfQuote } from '../../shared/types';
import { normalizeDate, timeToMinute } from '../turnover/market';

/** 这里只决定是否需要补查基金报价；最终仍以行情源的 ETF 类型确认，避免误认 LOF。 */
export function isEtfCandidate(symbol: string): boolean {
  return /^(?:sh5\d{5}|sz1[568]\d{4})$/.test(symbol);
}

function numeric(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

/**
 * 腾讯基金网页的 adaptHS 映射：61=stocktype，77=yzl，78=iopv，30=utime。
 * 81=jz 是正式净值且本接口不附净值日期，绝不能拿它替代 IOPV。
 * 字段依据：https://gu.qq.com/sh510300 的公开行情脚本。
 */
export function parseEtfQuote(symbol: string, fields: unknown[]): EtfQuote | undefined {
  if (!isEtfCandidate(symbol) || fields[2] !== symbol.slice(2) || fields[61] !== 'ETF') return undefined;
  const result: EtfQuote = {
    symbol,
    price: null,
    iopv: null,
    premiumRate: null,
    quoteTimestamp: null,
    timestampMs: null,
    source: '腾讯行情',
    notice: ''
  };
  try {
    const raw = fields[30];
    if (typeof raw !== 'string' || !/^\d{14}$/.test(raw)) throw new Error();
    const date = normalizeDate(raw.slice(0, 8));
    timeToMinute(raw.slice(8, 12));
    if (Number(raw.slice(12)) > 59) throw new Error();
    result.quoteTimestamp = raw;
    result.timestampMs = Date.parse(`${date}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12)}+08:00`);
  } catch {
    result.notice = '行情时间无效，暂不展示参考数值。';
    return result;
  }
  const price = numeric(fields[3]),
    iopv = numeric(fields[78]);
  result.price = price !== null && price > 0 ? price : null;
  result.iopv = iopv !== null && iopv > 0 ? iopv : null;
  if (result.iopv === null) result.notice = '暂无有效 IOPV，无法计算折溢价率。';
  else if (result.price === null) result.notice = '暂无有效成交价，无法计算折溢价率。';
  else {
    const calculated = (result.price / result.iopv - 1) * 100;
    const reported = numeric(fields[77]);
    // IOPV 仅有四位小数，低价 ETF 的舍入误差更大；容差以百分点计。
    const tolerance = 0.015 + (100 * result.price * 0.00005) / (result.iopv * result.iopv);
    if (!Number.isFinite(calculated) || (reported !== null && Math.abs(reported - calculated) > tolerance)) {
      result.notice = '折溢价字段与同批价格、IOPV 不一致，暂不展示折溢价率。';
    } else {
      result.premiumRate = reported ?? calculated;
    }
  }
  return result;
}
