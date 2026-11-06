'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { turnoverSignal, TurnoverAlerts } = require('../dist/features/turnover/alerts.js');
const { buildSnapshot, parseMinute, parseHistory, session } = require('../dist/features/turnover/market.js');
const { SYMBOLS, minutePayload, historyPayload } = require('./fixtures.cts');
const { view } = require('../dist/features/turnover/view.js');
const now = new Date('2026-10-26T10:30:30+08:00'),
  clock = session(now);
const config = {
  enabled: true,
  comparisonMode: 'sameTime',
  colorMode: 'neutral',
  turnoverAlerts: { enabled: true, percent: 20, colorize: true }
};
function snapshot(percent = 21) {
  const s = buildSnapshot(
    SYMBOLS.map((x) => parseMinute(minutePayload(x), x)),
    SYMBOLS.map((x) => parseHistory(historyPayload(x), x)),
    now
  );
  s.sameTime = { previous: 200e8, current: 200e8 * (1 + percent / 100), delta: (200e8 * percent) / 100, percent };
  return s;
}
test('严格超过20%才触发红放绿缩，阈值内和持平恢复常规颜色', () => {
  for (const [percent, expected] of [
    [0, undefined],
    [20, undefined],
    [-20, undefined],
    [20.01, 'charts.red'],
    [-20.01, 'charts.green']
  ]) {
    const s = snapshot(percent),
      signal = turnoverSignal(s, {}, config, clock, now);
    assert.equal(signal?.color, expected);
    assert.equal(view(s, {}, config, clock, now).color, expected);
  }
  assert.equal(turnoverSignal(snapshot(25), {}, { ...config, turnoverAlerts: { percent: 30 } }, clock, now), null);
  assert.equal(
    view(snapshot(), {}, { ...config, turnoverAlerts: { ...config.turnoverAlerts, colorize: false } }, clock, now)
      .color,
    undefined
  );
  assert.equal(view(snapshot(10), {}, { ...config, colorMode: 'redUpGreenDown' }, clock, now).color, 'charts.red');
});
test('当日同方向只提醒一次，跨方向可提醒；重启和口径切换不重发，次日重新计数', async () => {
  const map = new Map(),
    messages = [],
    storage = { get: (k) => map.get(k), update: async (k, v) => map.set(k, v) };
  let alerts = new TurnoverAlerts(storage, (m) => messages.push(m));
  for (const percent of [20, 21, 30, 19, 21, -21, -30]) alerts.check(snapshot(percent), {}, config, clock, now);
  await alerts.write;
  assert.equal(messages.length, 2);
  assert.match(messages[0], /沪深 A 股较上一交易日同刻 10:30放量 21.00%/);
  assert.match(messages[1], /缩量 21.00%/);
  alerts = new TurnoverAlerts(storage, (m) => messages.push(m));
  alerts.check(snapshot(21), {}, config, clock, now);
  alerts.check(snapshot(), {}, { ...config, comparisonMode: 'previousDay' }, clock, now);
  assert.equal(messages.length, 2);
  const tomorrow = new Date('2026-10-27T10:30:30+08:00'),
    s = snapshot();
  s.date = '2026-10-27';
  s.previousDate = '2026-10-26';
  s.fetchedAt = tomorrow.toISOString();
  for (const m of s.markets) m.timestamp = '20261027103030';
  alerts.check(s, {}, config, session(tomorrow), tomorrow);
  assert.equal(messages.length, 3);
  await alerts.write;
});
test('行情新鲜但同刻分时滞后、异常日期时间、缓存或零基准时不误报', () => {
  const variants = [
    (s) => {
      s.comparisonTime = '10:25';
    },
    (s) => {
      s.comparisonTime = '10:31';
    },
    (s) => {
      s.comparisonTime = '25:00';
    },
    (s) => {
      s.markets[0].timestamp = '20261026102530';
    },
    (s) => {
      s.markets[0].timestamp = '20261026103130';
    },
    (s) => {
      s.markets[1].timestamp = '20261023103030';
    },
    (s) => {
      s.fetchedAt = 'bad';
    },
    (s) => {
      s.fetchedAt = '2026-10-26T10:28:00+08:00';
    },
    (s) => {
      s.fetchedAt = '2026-10-26T10:31:00+08:00';
    },
    (s) => {
      s.sameTime.previous = 0;
    },
    (s) => {
      s.sameTime.percent = NaN;
    },
    (s) => {
      s.sameTime = null;
    },
    (s) => {
      s.previousDate = '2026-10-27';
    },
    (s) => {
      s.date = '2026-10-23';
    }
  ];
  for (const mutate of variants) {
    const s = snapshot();
    mutate(s);
    assert.equal(turnoverSignal(s, {}, config, clock, now), null, mutate.toString());
  }
  const lagging = snapshot();
  lagging.comparisonTime = '10:25';
  assert.equal(view(lagging, {}, config, clock, now).color, undefined);
  for (const state of [{ paused: true }, { cached: true }, { error: '超时' }])
    assert.equal(turnoverSignal(snapshot(), state, config, clock, now), null);
});
test('午休及收盘保留有效变色但不弹窗；休市盘前不提示，下午开盘按交易分钟判断', () => {
  const messages = [],
    alerts = new TurnoverAlerts({ get: () => ({}), update: async () => {} }, (m) => messages.push(m));
  for (const [time, stamp, comparisonTime] of [
    ['12:00:00', '113000', '11:30'],
    ['15:30:00', '150000', '15:00']
  ]) {
    const at = new Date(`2026-10-26T${time}+08:00`),
      s = snapshot();
    s.comparisonTime = comparisonTime;
    for (const m of s.markets) m.timestamp = '20261026' + stamp;
    assert.equal(turnoverSignal(s, {}, config, session(at), at).color, 'charts.red');
    alerts.check(s, {}, config, session(at), at);
  }
  assert.equal(messages.length, 0);
  const afternoon = new Date('2026-10-26T13:00:30+08:00'),
    s = snapshot();
  s.fetchedAt = afternoon.toISOString();
  s.comparisonTime = '11:30';
  for (const m of s.markets) m.timestamp = '20261026130030';
  assert.ok(turnoverSignal(s, {}, config, session(afternoon), afternoon));
  for (const phase of ['before', 'closed'])
    assert.equal(turnoverSignal(snapshot(), {}, config, { ...clock, phase }, now), null);
});
test('提醒和颜色开关独立，关闭成交额或暂停不消耗提醒次数', async () => {
  const messages = [],
    alerts = new TurnoverAlerts({ get: () => ({}), update: async () => {} }, (m) => messages.push(m));
  const off = { ...config, turnoverAlerts: { ...config.turnoverAlerts, enabled: false } };
  alerts.check(snapshot(), {}, off, clock, now);
  assert.equal(view(snapshot(), {}, off, clock, now).color, 'charts.red');
  alerts.check(snapshot(), {}, { ...config, enabled: false }, clock, now);
  alerts.check(snapshot(), { paused: true }, config, clock, now);
  assert.equal(messages.length, 0);
  alerts.check(
    snapshot(),
    {},
    { ...config, turnoverAlerts: { ...config.turnoverAlerts, colorize: false } },
    clock,
    now
  );
  assert.equal(messages.length, 1);
  await alerts.write;
});
test('全天口径与状态栏一致；存储及通知失败不影响行情，也不连续刷屏', async () => {
  const warnings = [],
    logs = [],
    alerts = new TurnoverAlerts(
      {
        get: () => ({}),
        update: async () => {
          throw new Error('只读');
        }
      },
      (m) => {
        warnings.push(m);
        throw new Error('窗口关闭');
      },
      (m) => logs.push(m)
    );
  const allDay = { ...config, comparisonMode: 'previousDay' };
  assert.equal(view(snapshot(), {}, allDay, clock, now).color, 'charts.green');
  alerts.check(snapshot(), {}, allDay, clock, now);
  await alerts.write;
  alerts.check(snapshot(), {}, allDay, clock, now);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /上一交易日全天缩量 33.33%/);
  assert.equal(logs.length, 2);
});
