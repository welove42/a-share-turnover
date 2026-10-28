'use strict';
const { normalizeDate, timeToMinute, tradingMinute, PHASE_LABELS } = require('./market');
const { label: temperatureLabel } = require('../media/temperature-model');

const clamp = value => Math.max(0, Math.min(100, value));
const missing = (label, reason) => ({ score: null, label, reason });
const signed = value => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

// A transparent local sentiment gauge, not an exchange-defined technical index.
function marketTemperature(snapshot, state, clock, now) {
  if (state.paused) return missing('已暂停', '自动刷新已暂停，恢复后重新计算。');
  if (clock.phase === 'before' || clock.phase === 'closed') return missing(clock.phase === 'before' ? '盘前' : '休市', '当前不计算实时温度；开盘后更新。');
  if (!snapshot) return missing('待更新', state.error ? '行情获取失败，等待重试。' : '等待沪深A股行情。');
  if (snapshot.date !== clock.date || state.cached || state.error) return missing('待更新', '当前为缓存、历史行情或请求失败，不能代表当前市场温度。');
  const fetched = Date.parse(snapshot.fetchedAt), age = now.getTime() - fetched;
  if (!Number.isFinite(age) || age < -30000 || (clock.polling && age > 90000)) return missing('待更新', '行情获取时间异常或数据已过期。');
  const inputs = ['sh000002', 'sz399107'].map(symbol => snapshot.markets?.find(m => m.symbol === symbol));
  const minutes = [];
  for (const market of inputs) {
    if (!market || !/^\d{14}$/.test(market.timestamp || '')) return missing('待更新', '沪深行情时间字段缺失。');
    try {
      if (normalizeDate(market.timestamp.slice(0, 8)) !== snapshot.date || Number(market.timestamp.slice(12)) > 59) throw new Error();
      const minute = timeToMinute(market.timestamp.slice(8, 12));
      // The quote service emits heartbeat timestamps during lunch and after close.
      // Compare elapsed trading minutes below instead of rejecting these clocks.
      if (minute < 570 || minute > clock.minute + 1) throw new Error();
      minutes.push(minute);
    } catch { return missing('待更新', '沪深行情日期或时间异常。'); }
    const counts = market.breadth && ['advancing', 'unchanged', 'declining'].map(key => market.breadth[key]);
    if (!counts || !counts.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 100000) || counts.reduce((a, b) => a + b, 0) < 100
      || !Number.isFinite(market.percent) || Math.abs(market.percent) > 100) return missing('待更新', '缺少完整的沪深涨跌家数或指数涨跌幅。');
  }
  const tradingTimes = minutes.map(tradingMinute), earliest = Math.min(...tradingTimes);
  if (Math.max(...tradingTimes) - earliest > 2 || tradingMinute(clock.minute) - earliest > 2) return missing('待更新', '两市报价不同步，或行情落后超过两个交易分钟。');
  if (earliest < 5) return missing('开盘观察', '开盘前5个交易分钟不分级，09:35起计算，减少集合竞价扰动。');
  if (!snapshot.sameTime || !Number.isFinite(snapshot.sameTime.percent) || snapshot.sameTime.percent < -100 || !/^\d{2}:\d{2}$/.test(snapshot.comparisonTime || '')) return missing('待更新', '缺少昨日同刻成交额基准，等待行情补齐。');
  try {
    const comparison = timeToMinute(snapshot.comparisonTime.replace(':', ''));
    if (!((comparison >= 570 && comparison <= 690) || (comparison >= 780 && comparison <= 900)) || Math.abs(tradingMinute(comparison) - earliest) > 2) throw new Error();
  } catch { return missing('待更新', '成交额比较时间与指数行情不同步。'); }
  const counts = Object.fromEntries(['advancing', 'unchanged', 'declining'].map(key => [key, inputs.reduce((sum, m) => sum + m.breadth[key], 0)]));
  const total = counts.advancing + counts.unchanged + counts.declining;
  if (total < 1000) return missing('待更新', '涨跌家数覆盖不足，暂不计算市场温度。');
  const averagePercent = inputs.reduce((sum, m) => sum + m.percent, 0) / 2;
  const components = {
    breadth: 100 * (counts.advancing + counts.unchanged / 2) / total,
    momentum: clamp(50 + averagePercent / 3 * 50),
    turnover: clamp(50 + snapshot.sameTime.percent)
  };
  const score = Math.round(.6 * components.breadth + .25 * components.momentum + .15 * components.turnover);
  const label = temperatureLabel(score);
  return { score, label, components, counts, total, averagePercent, volumePercent: snapshot.sameTime.percent,
    markets: inputs, comparisonTime: snapshot.comparisonTime, date: snapshot.date,
    phase: PHASE_LABELS[clock.phase], reason: '' };
}

function temperatureView(result, options = {}) {
  const scored = result.score !== null;
  const text = scored ? `温度 ${result.score} ${result.label}` : `温度 · ${result.label}`;
  const lines = ['**沪深A股市场温度（自定义）**', '', scored ? `**${result.score}/100 · ${result.label}**` : result.reason, ''];
  if (scored) {
    lines.push(`行情日期：${result.date}；${result.phase}。沪深报价：${result.markets.map(m => m.timestamp.slice(8).replace(/(..)(..)(..)/, '$1:$2:$3')).join(' / ')}（北京）。`, '',
      `上涨 **${result.counts.advancing}** 家 / 下跌 **${result.counts.declining}** 家 / 平盘 **${result.counts.unchanged}** 家；合计 ${result.total} 家，上涨占比 ${(result.counts.advancing / result.total * 100).toFixed(1)}%。`, '',
      `沪市A股 ${signed(result.markets[0].percent)}；深市A股 ${signed(result.markets[1].percent)}；两指数涨跌幅的算术均值 ${signed(result.averagePercent)}。`, '',
      `成交额较昨日同刻 ${result.comparisonTime}：${signed(result.volumePercent)}。`, '',
      '| 组成 | 权重 | 得分（0–100） |', '| --- | ---: | ---: |',
      `| 涨跌家数 | 60% | ${result.components.breadth.toFixed(1)} |`,
      `| 指数走势 | 25% | ${result.components.momentum.toFixed(1)} |`,
      `| 成交活跃度 | 15% | ${result.components.turnover.toFixed(1)} |`, '');
  }
  lines.push('公式：涨跌家数分 = 100 ×（上涨家数 + 平盘家数÷2）÷总家数；走势分 = 50 + 两指数平均涨跌幅÷3 × 50；活跃分 = 50 + 同刻成交额变化百分数。各分项限制在0–100，加权后四舍五入。', '',
    '分级：0–19 冰点；20–39 偏冷；40–59 中性；60–79 偏热；80–100 过热。', '',
    '范围：腾讯上证A股（000002）与深证A指（399107）的涨跌家数及行情口径，不含北交所、B股；家数按数据源实际返回值统计。与当前自选个股无关。', '',
    '此指标描述参与度与活跃度，不预测未来涨跌；放量可能出现在上涨或下跌中，须结合现有风险提示。交易期间随成交额每10秒更新，可在设置中隐藏。', '',
    '点击查看当天温度走势图；图表右上角可查看计算明细。');
  const color = options.colorize !== false && scored ? result.score >= 60 ? 'charts.red' : result.score < 40 ? 'charts.blue' : undefined : undefined;
  return { text, markdown: lines.join('\n'), detail: lines.join('\n').replaceAll('**', ''), color,
    accessibility: `沪深A股市场${text}。${scored ? `范围0至100，行情日期${result.date}。` : result.reason}` };
}
module.exports = { marketTemperature, temperatureView };
