'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { marketTemperature, temperatureView } = require('../src/temperature');
const { session, parseBreadth, parseMinute, parseHistory, buildSnapshot } = require('../src/market');
const { SYMBOLS, minutePayload, historyPayload } = require('./fixtures');
const { harness } = require('./vscode-mock');
const NOW = new Date('2026-10-26T10:30:30+08:00');
function snapshot() {
  const s = buildSnapshot(SYMBOLS.map(symbol => parseMinute(minutePayload(symbol), symbol)), SYMBOLS.map(symbol => parseHistory(historyPayload(symbol), symbol)), NOW);
  s.markets.forEach((m, i) => { m.breadth = { advancing: 550, unchanged: 100, declining: 350 }; m.percent = i + 1; });
  s.sameTime.percent = 20; return s;
}
const assess = (s = snapshot(), state = {}, time = NOW) => marketTemperature(s, state, session(time), time);

test('涨跌家数按腾讯官方涨/平/跌字段解析，缺失和异常不能当成零', () => {
  assert.deepEqual(parseBreadth(['', '', '1234', '56', '789']), { advancing: 1234, unchanged: 56, declining: 789 });
  assert.deepEqual(parseBreadth(['', '', 1234, 56, 789]), { advancing: 1234, unchanged: 56, declining: 789 });
  for (const v of [null, [], ['', '', '', '1', '2'], ['', '', true, '1', '2'], ['', '', '1.2', '1', '2'], ['', '', -1, 2, 3], ['', '', Infinity, 2, 3], ['', '', 0, 0, 0]]) assert.equal(parseBreadth(v), null);
});

test('新增温度数据复用成交额原始响应；可选字段缺失不影响成交额或历史比较', () => {
  const markets = SYMBOLS.map(symbol => {
    const p = minutePayload(symbol); p.data[symbol].qt.zhishu = ['', '', '1234', '56', '789'];
    p.data[symbol].qt[symbol][3] = '3060'; p.data[symbol].qt[symbol][4] = '3000';
    return parseMinute(p, symbol);
  });
  const s = buildSnapshot(markets, [], NOW);
  assert.equal(s.amount, 400e8); assert.equal(s.sameTime, null);
  assert.deepEqual(s.markets[0].breadth, { advancing: 1234, unchanged: 56, declining: 789 });
  assert.ok(Math.abs(s.markets[0].percent - 2) < 1e-9);
  const missing = parseMinute(minutePayload(SYMBOLS[0]), SYMBOLS[0]);
  assert.equal(missing.breadth, null); assert.equal(missing.amount, 200e8);
});

test('市场温度权重与独立手算一致，平盘折半，沪深指数涨跌幅等权', () => {
  const r = assess();
  assert.deepEqual(r.components, { breadth: 60, momentum: 75, turnover: 70 });
  assert.equal(r.score, 65); assert.equal(r.label, '偏热');
  assert.equal(r.averagePercent, 1.5); assert.equal(r.total, 2000);
  assert.deepEqual(r.counts, { advancing: 1100, unchanged: 200, declining: 700 });
});

test('五档边界和四舍五入一致，各项限定0–100，放巨量下跌仍可到冰点', () => {
  for (const [n, label] of [[0,'冰点'], [19,'冰点'], [20,'偏冷'], [39,'偏冷'], [40,'中性'], [59,'中性'], [60,'偏热'], [79,'偏热'], [80,'过热'], [100,'过热']]) {
    const s = snapshot(); s.sameTime.percent = n - 50;
    s.markets.forEach(m => { m.breadth = { advancing: n * 10, unchanged: 0, declining: 1000 - n * 10 }; m.percent = (n - 50) / 50 * 3; });
    assert.equal(assess(s).score, n); assert.equal(assess(s).label, label);
  }
  const s = snapshot(); s.sameTime.percent = 500;
  s.markets.forEach(m => { m.breadth = { advancing: 0, unchanged: 0, declining: 1000 }; m.percent = -5; });
  assert.equal(assess(s).score, 15); assert.equal(assess(s).label, '冰点');
  s.markets.forEach(m => { m.breadth = { advancing: 0, unchanged: 1000, declining: 0 }; m.percent = 0; });
  s.sameTime.percent = 0;
  assert.equal(assess(s).score, 50); assert.equal(assess(s).label, '中性');
});

test('暂停、缓存、错误、旧日、未开盘、休市和过期行情不给出冷热结论', () => {
  for (const state of [{ paused: true }, { cached: true }, { error: '断网' }]) assert.equal(assess(snapshot(), state).score, null);
  assert.equal(assess({ ...snapshot(), date: '2026-10-23' }).score, null);
  assert.equal(assess(null).score, null);
  for (const time of ['2026-10-26T09:29:59+08:00','2026-10-25T10:00:00+08:00','2026-10-26T10:32:01+08:00']) assert.equal(assess(snapshot(), {}, new Date(time)).score, null);
  assert.equal(assess({ ...snapshot(), fetchedAt: 'bad' }).score, null);
  assert.equal(assess({ ...snapshot(), fetchedAt: '2026-10-26T02:32:00Z' }).score, null);
});

test('任一市场缺失、家数覆盖不足、涨跌幅无效或同刻基准缺失时不降级冒充完整温度', () => {
  for (const mutate of [s=>s.markets.pop(), s=>s.markets[0].breadth=null, s=>s.markets[1].percent=null,
    s=>s.markets[1].percent=NaN, s=>s.markets[1].breadth.advancing=-1,
    s=>s.markets.forEach(m=>m.breadth={advancing:150,unchanged:10,declining:150}),
    s=>s.sameTime=null, s=>s.sameTime.percent=Infinity, s=>s.comparisonTime='10:20', s=>s.comparisonTime='10:99',
    s=>s.markets[1].timestamp='20261026102500', s=>s.markets[1].timestamp='20261025103030', s=>s.markets[1].timestamp='20261026259900']) {
    const s = snapshot(); mutate(s); assert.equal(assess(s).score, null);
  }
});

test('开盘5分钟观察期、午休和收盘快照，过午休旧报价不能冒充新报价', () => {
  const at = (time, quote) => {
    const now = new Date('2026-10-26T' + time + '+08:00'), s = snapshot();
    s.fetchedAt = now.toISOString(); s.comparisonTime = `${quote.slice(0,2)}:${quote.slice(2)}`;
    s.markets.forEach(m=>m.timestamp='20261026'+quote+'00');
    return assess(s, {}, now);
  };
  assert.equal(at('09:34:30','0934').label, '开盘观察');
  assert.equal(at('09:35:00','0935').score, 65);
  assert.equal(at('12:30:00','1130').score, 65);
  assert.equal(at('15:30:00','1500').score, 65);
  assert.equal(at('13:10:00','1130').score, null);
  for (const [time, heartbeat, comparisonTime] of [['11:35:00','1133','11:30'], ['15:10:00','1508','15:00']]) {
    const now = new Date('2026-10-26T' + time + '+08:00'), s = snapshot();
    s.fetchedAt = now.toISOString(); s.comparisonTime = comparisonTime;
    s.markets.forEach(m=>m.timestamp='20261026'+heartbeat+'00');
    assert.equal(assess(s, {}, now).score, 65);
    s.comparisonTime = '23:59'; assert.equal(assess(s, {}, now).score, null);
  }
});

test('状态栏短文本、分项解释与数据日期完整，不输出NaN或假中性', () => {
  const view = temperatureView(assess());
  assert.equal(view.text, '温度 65 偏热'); assert.equal(view.color, 'charts.red');
  assert.match(view.markdown, /1100.*700.*200/); assert.match(view.markdown, /60%.*60.0/);
  assert.match(view.markdown, /2026-10-26.*10:30:30/);
  assert.match(view.markdown, /自定义/); assert.match(view.markdown, /不含北交所/);
  assert.equal(temperatureView(assess(), {colorize:false}).color, undefined);
  const invalid = temperatureView(assess(null));
  assert.equal(invalid.text, '温度 · 待更新'); assert.doesNotMatch(invalid.markdown, /NaN|Infinity|50\/100/);
});

test('温度状态栏不增加行情请求，重复刷新和每秒检查不重建hover，支持独立隐藏和点击明细', async () => {
  const h = harness(), { TurnoverController } = h.load('../src/extension');
  let now = NOW, calls = 0;
  const c = new TurnoverController(h.context, { load: async () => { calls++; return snapshot(); } }, () => now);
  c.lastDate = '2026-10-26'; c.lastPhase = 'trading';
  try {
    await c.refresh(); assert.equal(calls, 1); assert.equal(c.temperatureItem.text, '温度 65 偏热');
    assert.equal(c.temperatureItem.tooltip.isTrusted, false); assert.equal(c.temperatureItem.tooltip.supportHtml, false);
    const writes = { ...c.temperatureItem.writes }, tooltip = c.temperatureItem.tooltip;
    for (let second=31; second<=39; second++) { now = new Date(`2026-10-26T10:30:${second}+08:00`); await c.tick(); }
    assert.equal(calls, 1); assert.deepEqual(c.temperatureItem.writes, writes); assert.equal(c.temperatureItem.tooltip, tooltip);
    c.showTemperature(); assert.equal(c.temperatureOutput.shown, 1); assert.match(c.temperatureOutput.lines[0], /65\/100/);
    await c.refresh(); assert.equal(calls, 2); assert.equal(c.temperatureItem.tooltip, tooltip);
    await h.api.workspace.getConfiguration('aShareTurnover').update('temperature.enabled', false);
    assert.equal(c.temperatureItem.visible, false); assert.equal(c.item.visible, true);
    await h.api.workspace.getConfiguration('aShareTurnover').update('temperature.enabled', true);
    assert.equal(c.temperatureItem.visible, true);
    c.state.error='断网'; c.render(); assert.equal(c.temperatureItem.text, '温度 · 待更新');
    c.state.error=''; await c.togglePause(); assert.equal(c.temperatureItem.text, '温度 · 已暂停');
    await h.api.workspace.getConfiguration('aShareTurnover').update('enabled', false);
    assert.equal(c.temperatureItem.visible, false); assert.equal(c.item.visible, false);
  } finally { c.dispose(); }
});
