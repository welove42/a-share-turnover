'use strict';
const { requestJson } = require('./http');
const { normalizeSymbol } = require('./quotes');
const { normalizeDate, timeToMinute } = require('./market');

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
function number(value, label) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') throw new Error(`${label}缺失`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label}异常`);
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
  if (!['intraday', 'daily'].includes(mode)) throw new Error('图表类型无效');
  const data = payload?.code === 0 && payload.data?.[symbol];
  if (!data) throw new Error('未获取到图表数据，请检查代码或稍后刷新');
  const bars = [], meta = metadata(data, symbol);
  let date, adjustment = '不复权';
  if (mode === 'intraday') {
    date = normalizeDate(data.data?.date);
    if (!Array.isArray(data.data?.data)) throw new Error('缺少分时数据');
    let cumulative = 0, lastMinute = -1;
    for (const row of data.data.data) {
      if (typeof row !== 'string') throw new Error('分时格式异常');
      const [time, rawPrice, rawVolume] = row.trim().split(/\s+/);
      const minute = timeToMinute(time);
      if (!((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900))) continue;
      const price = number(rawPrice, '分时价格'), total = number(rawVolume, '累计成交量');
      if (minute <= lastMinute || total < cumulative) throw new Error('分时累计成交量或时间顺序异常');
      lastMinute = minute;
      const volume = total - cumulative; cumulative = total;
      if (price > 0) bars.push({ time, open: price, close: price, high: price, low: price, volume });
    }
  } else {
    const rows = Array.isArray(data.qfqday) && data.qfqday.length ? data.qfqday : data.day;
    if (!Array.isArray(rows)) throw new Error('缺少日K数据');
    adjustment = rows === data.qfqday ? '前复权' : '不复权';
    for (const row of rows) {
      if (!Array.isArray(row)) throw new Error('日K格式异常');
      const time = normalizeDate(String(row[0]).replaceAll('-', ''));
      const [open, close, high, low, volume] = row.slice(1, 6).map(value => number(value, '日K字段'));
      if (open === 0 && close === 0 && high === 0 && low === 0) continue;
      if (low <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || (bars.length && time <= bars.at(-1).time)) throw new Error('日K价格或日期顺序异常');
      bars.push({ time, open, close, high, low, volume });
    }
    date = bars.at(-1)?.time;
  }
  if (!bars.length) throw new Error('暂无有效成交数据（可能尚未开盘、停牌或行情源暂不支持）');
  return { symbol, mode, ...meta, date, adjustment, bars: bars.slice(-300), source: '腾讯行情' };
}
class ChartProvider {
  constructor(request = requestJson) { this.request = request; }
  async load(input, mode, signal) {
    const symbol = normalizeSymbol(input);
    if (!['intraday', 'daily'].includes(mode)) throw new Error('图表类型无效');
    const url = mode === 'intraday'
      ? `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`
      : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,180,qfq`;
    return parseChart(await this.request(url, signal), symbol, mode);
  }
}
module.exports = { eastmoneyUrl, eastmoneyChartUrl, supportsChips, parseChart, ChartProvider };
