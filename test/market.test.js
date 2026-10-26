'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const market = require('../src/market');
const { SYMBOLS, minutePayload, historyPayload } = require('./fixtures');
const now = new Date('2026-10-26T10:30:30+08:00');
const at = stamp => market.session(new Date(stamp + '+08:00'));
const markets = () => SYMBOLS.map(symbol => market.parseMinute(minutePayload(symbol), symbol));
const histories = () => SYMBOLS.map(symbol => market.parseHistory(historyPayload(symbol), symbol));

test('北京时间固定 UTC+8，跨 UTC 日期也正确', () => {
  assert.deepEqual(market.shanghaiClock(new Date('2026-10-25T16:01:02Z')), {
    date: '2026-10-26', time: '00:01:02', weekday: 1, minute: 1
  });
});

test('开盘、午休、下午及收盘边界', () => {
  const cases = [
    ['09:29:59', 'before', false], ['09:30:00', 'trading', true],
    ['11:29:59', 'trading', true], ['11:30:00', 'lunch', false],
    ['12:59:59', 'lunch', false], ['13:00:00', 'trading', true],
    ['14:59:59', 'trading', true], ['15:00:00', 'settling', true],
    ['15:01:59', 'settling', true], ['15:02:00', 'after', false]
  ];
  for (const [time, phase, polling] of cases) {
    const result = at('2026-10-26T' + time);
    assert.equal(result.phase, phase, time);
    assert.equal(result.polling, polling, time);
  }
});

test('周末、交易所节假日及自定义休市；调休周六不交易', () => {
  for (const date of ['2026-10-24', '2026-10-25', '2026-10-01', '2026-10-10', '2026-02-23', '2026-09-25']) {
    assert.equal(at(date + 'T10:00:00').phase, 'closed', date);
  }
  assert.equal(at('2026-10-08T10:00:00').phase, 'trading');
  assert.equal(market.session(now, ['2026-10-26']).phase, 'closed');
});

test('实时成交额按元读取，避免误把万元当元', () => {
  const parsed = market.parseMinute(minutePayload('sh000002', 123.4567e8), 'sh000002');
  assert.equal(parsed.amount, 123.4567e8);
  assert.equal(parsed.date, '2026-10-26');
});

test('分时的成交额已经累计，不重复相加；周一比较周五', () => {
  const result = market.buildSnapshot(markets(), histories(), now);
  assert.equal(result.amount, 400e8);
  assert.equal(result.previousDate, '2026-10-23');
  assert.equal(result.comparisonTime, '10:30');
  assert.equal(result.sameTime.current, 398e8);
  assert.equal(result.sameTime.previous, 200e8);
  assert.equal(result.sameTime.delta, 198e8);
  assert.ok(Math.abs(result.sameTime.percent - 99) < 1e-9);
  assert.equal(result.previousDay.previous, 600e8);
  assert.equal(result.previousDay.delta, -200e8);
  assert.equal(market.isSnapshot(result), true);
});

test('两市分时错开时使用共同分钟，不混合时间', () => {
  const current = markets();
  current[0].points.push({ time: '1031', amount: 202e8 });
  current[0].timestamp = '20261026103159';
  assert.equal(market.buildSnapshot(current, histories(), now).comparisonTime, '10:30');
});

test('一市昨日同一分钟缺失时不改用更早分钟或全天冒充', () => {
  const history = histories();
  history[0][1].points = history[0][1].points.filter(point => point.time !== '1030');
  const snapshot = market.buildSnapshot(markets(), history, now);
  assert.equal(snapshot.sameTime, null);
  assert.ok(snapshot.previousDay);
  assert.match(snapshot.warning, /10:30.*缺失/);
});

test('历史不完整、两市上一日不一致、历史缓存落后均不伪造比较', () => {
  for (const update of [
    h => h[1][1].points.pop(),
    h => h[1].splice(1, 1),
    h => h.forEach(days => days.shift())
  ]) {
    const h = histories(); update(h);
    const s = market.buildSnapshot(markets(), h, now);
    assert.equal(s.sameTime, null);
    assert.equal(s.previousDay, null);
  }
});

test('分时落后两个交易分钟以上时只保留全天比较', () => {
  const current = markets();
  current.forEach(item => { item.timestamp = '20261026104000'; });
  const result = market.buildSnapshot(current, histories(), now);
  assert.equal(result.sameTime, null);
  assert.ok(result.previousDay);
  assert.match(result.warning, /尚未更新/);
});

test('零基准不除零；无穷、负数、空值、坏日期及坏字段被拒绝', () => {
  assert.equal(market.change(10, 0), null);
  for (const value of [null, '', ' ', '-', '-1', Infinity, NaN]) assert.throws(() => market.numeric(value, '测试'));
  assert.throws(() => market.normalizeDate('20260230'));
  assert.throws(() => market.timeToMinute('1060'));
  assert.throws(() => market.parsePoints(['1030 3000 1000']));
  assert.throws(() => market.parsePoints(['1030 3000 1000 200', '1031 3000 1000 100']));
  assert.throws(() => market.parsePoints(['1030 3000 1000 100', '1030 3000 1000 100']));
  const payload = minutePayload('sh000002');
  payload.data.sh000002.data.date = '20261023';
  assert.throws(() => market.parseMinute(payload, 'sh000002'), /日期不一致/);
});

test('沪深日期不一致拒绝合并；损坏缓存拒绝载入', () => {
  const current = markets(); current[1].date = '2026-10-23';
  assert.throws(() => market.buildSnapshot(current, histories(), now), /日期不一致/);
  assert.equal(market.isSnapshot({}), false);
  const s = market.buildSnapshot(markets(), histories(), now);
  s.sameTime.percent = Infinity;
  assert.equal(market.isSnapshot(s), false);
});

test('全天比较与同刻比较会给出不同方向，展示各自真实含义', () => {
  const s = market.buildSnapshot(markets(), histories(), now);
  assert.ok(s.sameTime.delta > 0);
  assert.ok(s.previousDay.delta < 0);
});
