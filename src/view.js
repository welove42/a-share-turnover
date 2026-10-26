'use strict';

const { PHASE_LABELS, timeToMinute, tradingMinute, shanghaiClock } = require('./market');

function money(amount) { return `${(amount / 1e8).toFixed(2)}亿`; }
function signedMoney(amount) { return `${amount >= 0 ? '+' : '-'}${money(Math.abs(amount))}`; }

function describeChange(value, withAmount = true) {
  if (!value) return '比较待更新';
  const direction = Math.abs(value.delta) < 0.005 ? '持平' : value.delta > 0 ? '放量' : '缩量';
  if (direction === '持平') return '持平 0.00%';
  return `${direction} ${Math.abs(value.percent).toFixed(2)}%${withAmount ? ` (${signedMoney(value.delta)})` : ''}`;
}

function quoteClock(timestamp) {
  return `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}`;
}

function view(snapshot, state, config, clock, now = new Date()) {
  const phase = PHASE_LABELS[clock.phase];
  const mode = config.comparisonMode === 'previousDay' ? 'previousDay' : 'sameTime';
  const comparison = snapshot?.[mode];
  const basis = mode === 'sameTime' ? `同刻${snapshot?.comparisonTime ? ' ' + snapshot.comparisonTime : ''}` : '较昨全天';
  let lagging = false;
  if (snapshot && clock.phase === 'trading' && snapshot.date === clock.date) {
    lagging = snapshot.markets.some(market => tradingMinute(clock.minute)
      - tradingMinute(timeToMinute(market.timestamp.slice(8, 12))) > 2);
  }
  const cached = state.cached || (snapshot && now.getTime() - Date.parse(snapshot.fetchedAt) > 90000 && clock.polling);
  const staleDay = snapshot && snapshot.date !== clock.date;
  const problem = state.error || lagging || cached;
  const suffix = state.paused ? '已暂停' : problem ? '行情未更新' : phase;
  const dateTag = staleDay ? `${snapshot.date.slice(5)} ` : '';
  const prefix = state.busy && !snapshot ? '$(sync~spin)' : problem ? '$(warning)' : '$(pulse)';
  const text = snapshot
    ? `${prefix} 沪深A ${dateTag}${money(snapshot.amount)} | ${basis} ${describeChange(comparison, config.showDifferenceAmount)} · ${suffix}`
    : `${prefix} 沪深A ${state.error ? '获取失败，点击重试' : state.paused ? '已暂停' : '等待行情'}`;
  const lines = [
    '**沪深 A 股成交额**', '',
    '范围：上证 A 股（000002）＋深证 A 指（399107），不含北交所及 B 股。', '',
    `状态：${suffix}；北京时间日期 ${clock.date}。`, ''
  ];
  if (snapshot) {
    lines.push(`行情日期：**${snapshot.date}**${staleDay ? '（最近交易日，非今日行情）' : ''}。`, '',
      `累计成交额：**${money(snapshot.amount)}元**。`, '',
      '| 市场 | 累计成交额 | 行情时间（北京） |', '| --- | ---: | --- |',
      ...snapshot.markets.map((market, i) => `| ${i === 0 ? '沪市 A 股' : '深市 A 股'} | ${money(market.amount)}元 | ${quoteClock(market.timestamp)} |`), '',
      `上一交易日：${snapshot.previousDate || '待获取'}。`, '',
      `**较昨同刻${snapshot.comparisonTime ? ` ${snapshot.comparisonTime}` : ''}：${describeChange(snapshot.sameTime)}**。`, '');
    if (snapshot.sameTime) lines.push(`同刻累计：本日 ${money(snapshot.sameTime.current)}元 / 上一交易日 ${money(snapshot.sameTime.previous)}元。`, '');
    lines.push(`**较昨全天：${describeChange(snapshot.previousDay)}**。`, '');
    if (snapshot.previousDay) lines.push(`上一交易日全天：${money(snapshot.previousDay.previous)}元。`, '');
    const fetched = shanghaiClock(new Date(snapshot.fetchedAt));
    lines.push('同刻比较使用两日同一分钟的累计值，精度为分钟；顶部累计额使用最新实时报价。', '',
      `最近成功获取：${fetched.date} ${fetched.time}（北京）。`, '');
    if (snapshot.warning) lines.push(`提示：${snapshot.warning}。`, '');
  }
  if (state.error) lines.push(`请求失败：${state.error}。显示内容为上次成功数据。`, '');
  if (lagging) lines.push('行情时间落后超过两个交易分钟，请核对行情源状态。', '');
  if (cached) lines.push('当前显示缓存，等待新行情。', '');
  if (!clock.date.startsWith('2026-')) lines.push('本年份节假日尚未内置，请在设置中补充额外休市日期；日期异常的旧行情会明确标注。', '');
  lines.push('交易时段每 10 秒刷新；午休及休市暂停。15:00–15:02 核对收盘数据。', '', '点击打开刷新、暂停及比较口径菜单。');
  const color = config.colorMode === 'redUpGreenDown' && comparison && !problem && !staleDay && !state.paused
    ? comparison.delta > 0 ? 'charts.red' : comparison.delta < 0 ? 'charts.green' : undefined
    : undefined;
  return { text, markdown: lines.join('\n'), color, accessibility: text.replace(/\$\([^)]+\)\s*/g, '') };
}

module.exports = { money, signedMoney, describeChange, quoteClock, view };
