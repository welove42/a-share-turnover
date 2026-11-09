/** 数据源适配：统一价格、成交量单位及北京时间，缺失字段保留为空，不制造行情。 */
import type { PriceBar } from '../../shared/types';
interface RateMap extends Map<string, number> {
  source?: string;
  fetchedAt?: number;
  stale?: boolean;
}
import { requestJson } from '../../core/network/http';
import { normalizeSymbol, supportsTurnover, turnoverRate, dailyExtremes } from '../watchlist/quotes';
import { normalizeDate, timeToMinute } from '../turnover/market';
import { MinuteFeed } from '../turnover/minute-feed';
import { isEtfCandidate, parseEtfQuote } from '../funds/etf-quote';
const PERIODS = { daily: 'day', weekly: 'week', monthly: 'month' };
const MINUTES = ['m1', 'm5', 'm15', 'm30', 'm60'];

// Tencent reports STAR Market (688/689) volume in shares; other supported
// A-share stocks and ETFs are reported in lots. Our chart uses lots throughout.
const volumeInLots = (symbol, volume) => (/^sh68[89]\d{3}$/.test(symbol) ? volume / 100 : volume);

function eastmoneyUrl(input) {
  const symbol = normalizeSymbol(input),
    code = symbol.slice(2);
  if (symbol.startsWith('bj')) return `https://quote.eastmoney.com/bj/${code}.html`;
  if (/^sh000\d{3}$/.test(symbol) || /^sz399\d{3}$/.test(symbol)) return `https://quote.eastmoney.com/zs${code}.html`;
  return `https://quote.eastmoney.com/${symbol}.html`;
}
function supportsChips(input) {
  return /^(?:sh6\d{5}|sz(?:00|30)\d{4})$/.test(normalizeSymbol(input));
}
function eastmoneyChartUrl(input, mode = 'eastmoney') {
  const symbol = normalizeSymbol(input),
    code = symbol.slice(2);
  const market = symbol.startsWith('sh') ? '1' : '0';
  if (mode === 'chips' && supportsChips(symbol)) {
    return `https://quote.eastmoney.com/basic/h5chart-iframe.html?code=${code}&market=${market}`;
  }
  return `https://quote.eastmoney.com/basic/full.html?mcid=${market}.${code}`;
}
function number(value, label, signed = false) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw new Error(`${label}缺失`);
  const n = Number(value);
  if (!Number.isFinite(n) || (!signed && n < 0)) throw new Error(`${label}异常`);
  return n;
}
function metadata(data, symbol) {
  const q = data.qt?.[symbol] || [];
  const timestamp = /^\d{14}$/.test(q[30] || '') ? q[30] : '';
  let validQuoteTime = false;
  try {
    normalizeDate(timestamp.slice(0, 8));
    timeToMinute(timestamp.slice(8, 12));
    validQuoteTime = Number(timestamp.slice(12, 14)) <= 59;
  } catch {
    /* Missing or malformed quote timestamp. */
  }
  const eligible = supportsTurnover(symbol);
  const validQuote = validQuoteTime && q[2] === symbol.slice(2);
  const rate = eligible && validQuote ? turnoverRate(q[38]) : null;
  const extremes = validQuote ? dailyExtremes(q[33], q[34]) : { dailyHigh: null, dailyLow: null };
  return {
    name: typeof q[1] === 'string' ? q[1].slice(0, 100) : symbol,
    timestamp,
    previousClose: Number(q[4]) > 0 ? Number(q[4]) : null,
    turnoverApplicable: eligible,
    turnoverRate: rate,
    turnoverTimestamp: rate === null ? null : timestamp,
    etfEligible: isEtfCandidate(symbol) && (!q[61] || q[61] === 'ETF'),
    etf: parseEtfQuote(symbol, q),
    ...extremes,
    dailyQuoteTimestamp: extremes.dailyHigh !== null || extremes.dailyLow !== null ? timestamp : null
  };
}
function parseChart(payload, input, mode) {
  const symbol = normalizeSymbol(input);
  if (mode !== 'intraday' && !Object.hasOwn(PERIODS, mode) && !MINUTES.includes(mode)) throw new Error('图表类型无效');
  const data = payload?.code === 0 && payload.data?.[symbol];
  if (!data) throw new Error('未获取到图表数据，请检查代码或稍后刷新');
  const bars: PriceBar[] = [],
    meta = metadata(data, symbol);
  let date,
    adjustment = '不复权';
  if (mode === 'intraday') {
    date = normalizeDate(data.data?.date);
    if (!Array.isArray(data.data?.data)) throw new Error('缺少分时数据');
    let cumulative = 0,
      lastMinute = -1,
      previousAmount: number | null = 0,
      largestAmount = 0,
      lowestPrice = Infinity,
      highestPrice = 0;
    // These stocks/ETFs use 100 shares per lot. Index turnover cannot be
    // divided by aggregate constituent volume to obtain an index average.
    const supportsAverage = /^(?:sh[56]\d{5}|sz[03]\d{5}|sz1[568]\d{4}|bj\d{6})$/.test(symbol);
    for (const row of data.data.data) {
      if (typeof row !== 'string') throw new Error('分时格式异常');
      const [time, rawPrice, rawVolume, rawAmount] = row.trim().split(/\s+/);
      const minute = timeToMinute(time);
      if (!((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900))) continue;
      const price = number(rawPrice, '分时价格'),
        rawTotal = number(rawVolume, '累计成交量');
      if (minute <= lastMinute || rawTotal < cumulative) throw new Error('分时累计成交量或时间顺序异常');
      lastMinute = minute;
      const volume = volumeInLots(symbol, rawTotal - cumulative),
        total = volumeInLots(symbol, rawTotal);
      cumulative = rawTotal;
      const amountValue = rawAmount === undefined ? NaN : Number(rawAmount);
      const cumulativeAmount = Number.isFinite(amountValue) && amountValue >= largestAmount ? amountValue : null;
      const amount = cumulativeAmount !== null && previousAmount !== null ? cumulativeAmount - previousAmount : null;
      previousAmount = cumulativeAmount;
      if (cumulativeAmount !== null) largestAmount = cumulativeAmount;
      if (price > 0) {
        lowestPrice = Math.min(lowestPrice, price);
        highestPrice = Math.max(highestPrice, price);
      }
      const candidate =
        supportsAverage && total > 0 && cumulativeAmount !== null && cumulativeAmount > 0
          ? cumulativeAmount / (total * 100)
          : null;
      // Reject wildly inconsistent feed fields instead of flattening the entire chart.
      const averagePrice =
        candidate !== null && candidate >= lowestPrice * 0.5 && candidate <= highestPrice * 2 ? candidate : null;
      if (price > 0)
        bars.push({
          time,
          open: price,
          close: price,
          high: price,
          low: price,
          volume,
          cumulativeVolume: total,
          amount,
          cumulativeAmount,
          averagePrice
        });
    }
  } else if (MINUTES.includes(mode)) {
    const rows = data[mode];
    if (!Array.isArray(rows)) throw new Error('缺少分钟K线数据');
    for (const row of rows) {
      if (!Array.isArray(row) || !/^\d{12}$/.test(String(row[0]))) throw new Error('分钟K线时间格式异常');
      const raw = String(row[0]),
        day = normalizeDate(raw.slice(0, 8));
      timeToMinute(raw.slice(8));
      const time = `${day} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`;
      const [open, close, high, low, rawVolume] = row.slice(1, 6).map((value) => number(value, '分钟K线字段'));
      const volume = volumeInLots(symbol, rawVolume);
      if (open === 0 && close === 0 && high === 0 && low === 0) continue;
      if (
        low <= 0 ||
        low > Math.min(open, close) ||
        high < Math.max(open, close) ||
        (bars.length && time <= bars.at(-1)!.time)
      )
        throw new Error('分钟K线价格或时间顺序异常');
      bars.push({ time, open, close, high, low, volume });
    }
    date = bars.at(-1)?.time.slice(0, 10);
  } else {
    const period = PERIODS[mode],
      adjusted = data['qfq' + period];
    const rows = Array.isArray(adjusted) && adjusted.length ? adjusted : data[period];
    if (!Array.isArray(rows)) throw new Error('缺少所选周期K线数据');
    adjustment = rows === adjusted ? '前复权' : '不复权';
    for (const row of rows) {
      if (!Array.isArray(row)) throw new Error('日K格式异常');
      const time = normalizeDate(String(row[0]).replaceAll('-', ''));
      // Cash-dividend forward adjustment can legitimately make old prices negative.
      const adjustedPrices = adjustment === '前复权';
      const [open, close, high, low] = row.slice(1, 5).map((value) => number(value, 'K线价格', adjustedPrices));
      const volume = volumeInLots(symbol, number(row[5], 'K线成交量'));
      if (open === 0 && close === 0 && high === 0 && low === 0) continue;
      if (
        (!adjustedPrices && low <= 0) ||
        low > Math.min(open, close) ||
        high < Math.max(open, close) ||
        (bars.length && time <= bars.at(-1)!.time)
      )
        throw new Error('K线价格或日期顺序异常');
      bars.push({ time, open, close, high, low, volume });
    }
    date = bars.at(-1)?.time;
  }
  if (!bars.length) throw new Error('暂无有效成交数据（可能尚未开盘、停牌或行情源暂不支持）');
  return { symbol, mode, ...meta, date, adjustment, bars: bars.slice(-300), source: '腾讯行情' };
}
function parseFiveDayChart(payload, input) {
  const symbol = normalizeSymbol(input),
    source = payload?.code === 0 && payload.data?.[symbol];
  if (!source || !Array.isArray(source.data) || !source.data.length) throw new Error('缺少五日分时数据');
  const days = source.data
    .map((day) => ({ ...day, date: normalizeDate(day.date) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(days.map((day) => day.date)).size !== days.length) throw new Error('五日分时日期重复');
  const recent = days.slice(-5),
    meta = metadata(source, symbol),
    bars: (PriceBar & { date: string; dayIndex: number; previousClose: number | null })[] = [],
    dates: string[] = [];
  for (const day of recent) {
    if (!Array.isArray(day.data)) throw new Error('五日分时数据格式异常');
    if (!day.data.length) continue;
    const rawDate = day.date.replaceAll('-', '');
    const parsed = parseChart(
      { code: 0, data: { [symbol]: { data: { date: rawDate, data: day.data }, qt: source.qt } } },
      symbol,
      'intraday'
    );
    const dayIndex = dates.length;
    dates.push(day.date);
    const previousClose =
      day.date === recent.at(-1).date && meta.timestamp.slice(0, 8) === rawDate ? meta.previousClose : null;
    for (const bar of parsed.bars)
      bars.push({
        ...bar,
        date: day.date,
        time: `${day.date} ${bar.time.slice(0, 2)}:${bar.time.slice(2)}`,
        dayIndex,
        previousClose
      });
  }
  if (!bars.length) throw new Error('暂无有效五日分时数据');
  return {
    symbol,
    mode: 'intraday5',
    ...meta,
    previousClose: bars.at(-1)!.previousClose,
    date: dates.at(-1),
    dates,
    adjustment: '不复权',
    bars,
    source: '腾讯行情'
  };
}
class ChartProvider {
  declare request: typeof requestJson;
  declare minuteFeed: MinuteFeed;
  declare turnoverCache: Map<any, any>;

  constructor(request = requestJson) {
    this.request = request;
    this.minuteFeed = new MinuteFeed(request);
    this.turnoverCache = new Map();
  }
  async loadHistoricalTurnover(
    input,
    mode,
    signal?: AbortSignal,
    options: { force?: boolean; bars?: PriceBar[] } = {}
  ) {
    const symbol = normalizeSymbol(input);
    const klt = { intraday5: 101, daily: 101, weekly: 102, monthly: 103, m1: 1, m5: 5, m15: 15, m30: 30, m60: 60 }[
      mode
    ];
    if (!supportsTurnover(symbol) || !klt) return new Map();
    // Five-day intraday and daily use the same klt but need different history windows.
    const key = `${symbol}:${mode}`,
      cached = this.turnoverCache.get(key),
      now = Date.now();
    if (cached && now - cached.at < 60000 && !options.force) {
      if (cached.error && !cached.rates) throw new Error(cached.error);
      return cached.rates;
    }
    const market = symbol.startsWith('sh') ? 1 : 0;
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${symbol.slice(2)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=1&end=20500101&lmt=300`;
    const failures: string[] = [];
    const eastmoney = async (address) => {
      const payload = await this.request(address, signal, { Referer: 'https://quote.eastmoney.com/' });
      if (
        payload?.rc !== 0 ||
        payload.data?.code !== symbol.slice(2) ||
        payload.data?.market !== market ||
        !Array.isArray(payload.data?.klines)
      )
        throw new Error('数据不可用');
      const rates: RateMap = new Map();
      for (const row of payload.data.klines) {
        if (typeof row !== 'string') continue;
        const fields = row.split(','),
          time = fields[0],
          rate = turnoverRate(fields[10]);
        if (
          rate === null ||
          !(klt < 100 ? /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time) : /^\d{4}-\d{2}-\d{2}$/.test(time))
        )
          continue;
        rates.set(time, rate);
      }
      if (!rates.size) throw new Error('没有有效数据');
      return rates;
    };
    const sohu = async () => {
      const dates = (options.bars || [])
        .map((bar) => (bar.date || bar.time || '').slice(0, 10))
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort();
      const start = (dates[0] || '2010-01-01').replaceAll('-', ''),
        end = (dates.at(-1) || '2050-01-01').replaceAll('-', '');
      const period = klt === 101 ? 'd' : klt === 102 ? 'w' : 'm';
      const address = `https://q.stock.sohu.com/hisHq?code=cn_${symbol.slice(2)}&start=${start}&end=${end}&stat=1&order=D&period=${period}`;
      const payload = await this.request(address, signal, {
        Referer: 'https://q.stock.sohu.com/',
        'User-Agent': 'Mozilla/5.0'
      });
      const result = Array.isArray(payload) && payload[0];
      if (result?.status !== 0 || result.code !== `cn_${symbol.slice(2)}` || !Array.isArray(result.hq))
        throw new Error('数据不可用');
      const rates: RateMap = new Map();
      for (const row of result.hq) {
        if (
          !Array.isArray(row) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(row[0]) ||
          typeof row[9] !== 'string' ||
          !/^\d+(?:\.\d+)?%$/.test(row[9])
        )
          continue;
        rates.set(row[0], Number(row[9].slice(0, -1)));
      }
      if (!rates.size) throw new Error('没有有效数据');
      return rates;
    };
    const sources: [string, () => Promise<RateMap>][] = [['东方财富', () => eastmoney(url)]];
    if (klt >= 100 && !symbol.startsWith('bj')) sources.push(['搜狐财经', sohu]);
    else if (klt < 100)
      sources.push([
        '东方财富备用',
        () => eastmoney(url.replace('push2his.eastmoney.com', '54.push2his.eastmoney.com'))
      ]);
    for (const [source, load] of sources) {
      try {
        const rates = await load();
        if (signal?.aborted) throw new Error('请求已取消');
        rates.source = source;
        rates.fetchedAt = Date.now();
        this.turnoverCache.delete(key);
        this.turnoverCache.set(key, { at: Date.now(), rates });
        if (this.turnoverCache.size > 40) this.turnoverCache.delete(this.turnoverCache.keys().next().value);
        return rates;
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${source}：${error.message || '请求失败'}`);
      }
    }
    const message = `历史换手率获取失败（${failures.join('；')}）`;
    if (cached?.rates) {
      const rates: RateMap = new Map(cached.rates);
      rates.source = cached.rates.source;
      rates.fetchedAt = cached.rates.fetchedAt;
      rates.stale = true;
      this.turnoverCache.set(key, { at: now, rates });
      return rates;
    }
    this.turnoverCache.set(key, { at: now, error: message });
    if (this.turnoverCache.size > 40) this.turnoverCache.delete(this.turnoverCache.keys().next().value);
    throw new Error(message);
  }
  async load(input, mode, signal?: AbortSignal) {
    const symbol = normalizeSymbol(input);
    if (mode !== 'intraday' && mode !== 'intraday5' && !Object.hasOwn(PERIODS, mode) && !MINUTES.includes(mode))
      throw new Error('图表类型无效');
    if (mode === 'intraday5') {
      const { payload, backup } = await this.minuteFeed.loadHistory(symbol, signal);
      const data = parseFiveDayChart(payload, symbol);
      if (backup) data.source = '腾讯行情（五日分时备用）';
      return data;
    }
    if (mode === 'intraday') {
      const { payload, backup } = await this.minuteFeed.load(symbol, signal);
      const data = parseChart(payload, symbol, mode);
      if (backup) data.source = '腾讯行情（分时备用）';
      return data;
    }
    const url = MINUTES.includes(mode)
      ? `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},${mode},,240`
      : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${PERIODS[mode]},,,240,qfq`;
    return parseChart(await this.request(url, signal), symbol, mode);
  }
}
export { eastmoneyUrl, eastmoneyChartUrl, supportsChips, parseChart, parseFiveDayChart, ChartProvider };
