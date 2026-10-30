'use strict';
const { requestJson } = require('./http');
const { normalizeSymbol } = require('./quotes');
const { normalizeDate, timeToMinute } = require('./market');
const { MinuteFeed } = require('./minute-feed');
const PERIODS = { daily: 'day', weekly: 'week', monthly: 'month' };
const MINUTES = ['m1', 'm5', 'm15', 'm30', 'm60'];

function eastmoneyUrl(input) {
  const symbol = normalizeSymbol(input), code = symbol.slice(2);
  if (symbol.startsWith('bj')) return `https://quote.eastmoney.com/bj/${code}.html`;
  if (/^sh000\d{3}$/.test(symbol) || /^sz399\d{3}$/.test(symbol)) return `https://quote.eastmoney.com/zs${code}.html`;
  return `https://quote.eastmoney.com/${symbol}.html`;
}
function supportsChips(input) {
  return /^(?:sh6\d{5}|sz(?:00|30)\d{4})$/.test(normalizeSymbol(input));
}
function eastmoneyChartUrl(input, mode = 'eastmoney') {
  const symbol = normalizeSymbol(input), code = symbol.slice(2);
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
  return { name: typeof q[1] === 'string' ? q[1].slice(0, 100) : symbol,
    timestamp, previousClose: Number(q[4]) > 0 ? Number(q[4]) : null };
}
function parseChart(payload, input, mode) {
  const symbol = normalizeSymbol(input);
  if (mode !== 'intraday' && !Object.hasOwn(PERIODS, mode) && !MINUTES.includes(mode)) throw new Error('图表类型无效');
  const data = payload?.code === 0 && payload.data?.[symbol];
  if (!data) throw new Error('未获取到图表数据，请检查代码或稍后刷新');
  const bars = [], meta = metadata(data, symbol);
  let date, adjustment = '不复权';
  if (mode === 'intraday') {
    date = normalizeDate(data.data?.date);
    if (!Array.isArray(data.data?.data)) throw new Error('缺少分时数据');
    let cumulative = 0, lastMinute = -1, previousAmount = 0, largestAmount = 0;
    // These stocks/ETFs use 100 shares per lot. Index turnover cannot be
    // divided by aggregate constituent volume to obtain an index average.
    const supportsAverage = /^(?:sh[56]\d{5}|sz[03]\d{5}|sz1[568]\d{4}|bj\d{6})$/.test(symbol);
    for (const row of data.data.data) {
      if (typeof row !== 'string') throw new Error('分时格式异常');
      const [time, rawPrice, rawVolume, rawAmount] = row.trim().split(/\s+/);
      const minute = timeToMinute(time);
      if (!((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900))) continue;
      const price = number(rawPrice, '分时价格'), total = number(rawVolume, '累计成交量');
      if (minute <= lastMinute || total < cumulative) throw new Error('分时累计成交量或时间顺序异常');
      lastMinute = minute;
      const volume = total - cumulative; cumulative = total;
      const amountValue = rawAmount === undefined ? NaN : Number(rawAmount);
      const cumulativeAmount = Number.isFinite(amountValue) && amountValue >= largestAmount ? amountValue : null;
      const amount = cumulativeAmount !== null && previousAmount !== null ? cumulativeAmount - previousAmount : null;
      previousAmount = cumulativeAmount;
      if (cumulativeAmount !== null) largestAmount = cumulativeAmount;
      const averagePrice = supportsAverage && total > 0 && cumulativeAmount > 0 ? cumulativeAmount / (total * 100) : null;
      if (price > 0) bars.push({ time, open: price, close: price, high: price, low: price, volume,
        cumulativeVolume: total, amount, cumulativeAmount, averagePrice });
    }
  } else if (MINUTES.includes(mode)) {
    const rows = data[mode];
    if (!Array.isArray(rows)) throw new Error('缺少分钟K线数据');
    for (const row of rows) {
      if (!Array.isArray(row) || !/^\d{12}$/.test(String(row[0]))) throw new Error('分钟K线时间格式异常');
      const raw = String(row[0]), day = normalizeDate(raw.slice(0, 8));
      timeToMinute(raw.slice(8));
      const time = `${day} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`;
      const [open, close, high, low, volume] = row.slice(1, 6).map(value => number(value, '分钟K线字段'));
      if (open === 0 && close === 0 && high === 0 && low === 0) continue;
      if (low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || (bars.length && time <= bars.at(-1).time)) throw new Error('分钟K线价格或时间顺序异常');
      bars.push({ time, open, close, high, low, volume });
    }
    date = bars.at(-1)?.time.slice(0, 10);
  } else {
    const period = PERIODS[mode], adjusted = data['qfq' + period];
    const rows = Array.isArray(adjusted) && adjusted.length ? adjusted : data[period];
    if (!Array.isArray(rows)) throw new Error('缺少所选周期K线数据');
    adjustment = rows === adjusted ? '前复权' : '不复权';
    for (const row of rows) {
      if (!Array.isArray(row)) throw new Error('日K格式异常');
      const time = normalizeDate(String(row[0]).replaceAll('-', ''));
      // Cash-dividend forward adjustment can legitimately make old prices negative.
      const adjustedPrices = adjustment === '前复权';
      const [open, close, high, low] = row.slice(1, 5).map(value => number(value, 'K线价格', adjustedPrices));
      const volume = number(row[5], 'K线成交量');
      if (open === 0 && close === 0 && high === 0 && low === 0) continue;
      if ((!adjustedPrices && low <= 0) || low > Math.min(open, close) || high < Math.max(open, close) || (bars.length && time <= bars.at(-1).time)) throw new Error('K线价格或日期顺序异常');
      bars.push({ time, open, close, high, low, volume });
    }
    date = bars.at(-1)?.time;
  }
  if (!bars.length) throw new Error('暂无有效成交数据（可能尚未开盘、停牌或行情源暂不支持）');
  return { symbol, mode, ...meta, date, adjustment, bars: bars.slice(-300), source: '腾讯行情' };
}
function parseFiveDayChart(payload, input) {
  const symbol = normalizeSymbol(input), source = payload?.code === 0 && payload.data?.[symbol];
  if (!source || !Array.isArray(source.data) || !source.data.length) throw new Error('缺少五日分时数据');
  const days = source.data.map(day => ({ ...day, date: normalizeDate(day.date) })).sort((a,b)=>a.date.localeCompare(b.date));
  if (new Set(days.map(day=>day.date)).size !== days.length) throw new Error('五日分时日期重复');
  const recent = days.slice(-5), meta = metadata(source, symbol), bars = [], dates = [];
  for (const day of recent) {
    if (!Array.isArray(day.data)) throw new Error('五日分时数据格式异常');
    if (!day.data.length) continue;
    const rawDate = day.date.replaceAll('-', '');
    const parsed = parseChart({ code:0, data:{ [symbol]: { data:{date:rawDate,data:day.data}, qt:source.qt } } },symbol,'intraday');
    const dayIndex = dates.length; dates.push(day.date);
    const previousClose = day.date === recent.at(-1).date && meta.timestamp.slice(0,8) === rawDate ? meta.previousClose : null;
    for (const bar of parsed.bars) bars.push({ ...bar, date:day.date, time:`${day.date} ${bar.time.slice(0,2)}:${bar.time.slice(2)}`, dayIndex, previousClose });
  }
  if (!bars.length) throw new Error('暂无有效五日分时数据');
  return { symbol, mode:'intraday5', ...meta, previousClose: bars.at(-1).previousClose, date:dates.at(-1), dates, adjustment:'不复权', bars, source:'腾讯行情' };
}
class ChartProvider {
  constructor(request = requestJson) { this.request = request; this.minuteFeed = new MinuteFeed(request); }
  async load(input, mode, signal) {
    const symbol = normalizeSymbol(input);
    if (mode !== 'intraday' && mode !== 'intraday5' && !Object.hasOwn(PERIODS, mode) && !MINUTES.includes(mode)) throw new Error('图表类型无效');
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
    const url = MINUTES.includes(mode) ? `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},${mode},,240`
      : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${PERIODS[mode]},,,240,qfq`;
    return parseChart(await this.request(url, signal), symbol, mode);
  }
}
module.exports = { eastmoneyUrl, eastmoneyChartUrl, supportsChips, parseChart, parseFiveDayChart, ChartProvider };
