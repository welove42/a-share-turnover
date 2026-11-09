'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { TemperatureHistory, restore } = require('../dist/features/temperature/history.js');
const { seconds, segments, nearest } = require('../dist/shared/temperature-model.js');
const { harness } = require('./vscode-mock.cts');
const { buildSnapshot, parseMinute, parseHistory } = require('../dist/features/turnover/market.js');
const { SYMBOLS, minutePayload, historyPayload } = require('./fixtures.cts');
const DATE = '2026-10-28';
const point = (time, score = 60) => ({
  time,
  score,
  phase: '交易中',
  sampledAt: new Date(`${DATE}T${time}+08:00`).toISOString()
});
function memory() {
  const values = new Map(),
    writes = [];
  return {
    values,
    writes,
    get: (key) => values.get(key),
    update: async (key, value) => {
      writes.push(value);
      values.set(key, value);
    }
  };
}
const result = (score) => ({ date: DATE, score, phase: '交易中' });

test('每分钟仅记录一次，减少存储和点数，不写入空温度或迟到数据', async () => {
  const store = memory(),
    history = new TemperatureHistory(store, DATE);
  assert.equal(history.record(result(55), point('10:30:01').sampledAt), true);
  assert.equal(history.record(result(58), point('10:30:08').sampledAt), false);
  assert.equal(history.points.length, 1);
  assert.equal(history.points[0].score, 55);
  assert.equal(history.points[0].time, '10:30:01');
  assert.equal(history.record(result(60), point('10:31:11').sampledAt), true);
  assert.equal(history.record(result(60), point('10:30:11').sampledAt), false);
  assert.equal(history.record(result(null), point('10:30:21').sampledAt), false);
  assert.equal(history.record(result(1000), point('10:30:21').sampledAt), false);
  assert.equal(history.record(result(20), point('10:30:07').sampledAt), false);
  assert.equal(history.record(result(20), 'bad'), false);
  await history.flush();
  assert.equal(history.points.length, 2);
  assert.equal(history.points[0].time, '10:30:01');
  assert.equal(store.writes.length, 2);
  assert.equal(store.values.get('temperatureHistory').points.length, 2);
});

test('重启恢复当天记录，跨日立即清空，不混入旧日；返回的数据不能修改缓存', async () => {
  const store = memory(),
    history = new TemperatureHistory(store, DATE);
  history.record(result(65), point('10:30:10').sampledAt);
  await history.flush();
  const restarted = new TemperatureHistory(store, DATE);
  assert.equal(restarted.points[0].score, 65);
  const copy = restarted.data();
  copy.points[0].score = 0;
  copy.points.push(point('10:35:00'));
  assert.equal(restarted.points.length, 1);
  assert.equal(restarted.points[0].score, 65);
  assert.equal(restarted.rollover('2026-10-29'), true);
  await restarted.flush();
  assert.deepEqual(restarted.data(), { date: '2026-10-29', points: [] });
  assert.equal(restarted.record(result(66), point('10:30:30').sampledAt), false);
  assert.equal(new TemperatureHistory(store, '2026-10-29').points.length, 0);
});

test('坏日期、坏分数、重复时段和不同模型缓存被拒绝，不将缺数据补成0', () => {
  const valid = { version: 1, model: 1, date: DATE, points: [point('10:30:10'), point('10:30:20')] };
  assert.equal(restore(valid, DATE).length, 1);
  for (const mutate of [
    (v) => (v.model = 2),
    (v) => (v.date = '2026-10-27'),
    (v) => (v.points[0].score = null),
    (v) => (v.points[0].score = NaN),
    (v) => (v.points[0].time = '25:30:10'),
    (v) => (v.points[0].sampledAt = 'bad'),
    (v) => (v.points[0].phase = '<script>'),
    (v) => (v.points[1] = point('10:30:19')),
    (v) => v.points.reverse(),
    (v) => (v.points[0].time = '10:20:10')
  ]) {
    const v = structuredClone(valid);
    mutate(v);
    assert.deepEqual(restore(v, DATE), []);
  }
});

test('持久化顺序不会让旧日覆盖新日，保存失败不丢失内存中的新数据', async () => {
  const store = memory(),
    logs = [];
  let release,
    calls = 0;
  const original = store.update;
  store.update = async (...args) => {
    calls++;
    if (calls === 1) await new Promise((r) => (release = r));
    return original(...args);
  };
  const history = new TemperatureHistory(store, DATE, (message) => logs.push(message));
  history.record(result(70), point('10:30:10').sampledAt);
  await new Promise((r) => setImmediate(r));
  history.rollover('2026-10-29');
  release();
  await history.flush();
  assert.equal(store.values.get('temperatureHistory').date, '2026-10-29');
  store.update = async () => {
    throw new Error('磁盘失败');
  };
  history.record({ date: '2026-10-29', score: 71, phase: '交易中' }, '2026-10-29T02:30:10.000Z');
  await history.flush();
  assert.equal(history.points[0].score, 71);
  assert.match(logs[0], /保存失败/);
});

test('分钟采样及短暂延迟保持连线，午休和较长缺采分段，悬停寻找真实记录', () => {
  const points = ['10:00:00', '10:00:10', '10:02:00', '11:30:00', '13:00:00'].map((t) => point(t));
  assert.equal(segments(points).length, 3);
  assert.equal(nearest(points, seconds('10:00:19')), 1);
  assert.equal(nearest(points, seconds('10:01:58')), 2);
  assert.equal(nearest([], 0), -1);
  assert.equal(seconds('10:99:00'), null);
  assert.equal(seconds('10:30:60'), null);
});

test('只有成功且有效的刷新才采集；每秒时钟、失败及暂停不追加；走势图单标签复用', async () => {
  const h = harness(),
    { TurnoverController } = h.load('../dist/app/extension.js');
  let now = new Date('2026-10-28T10:30:30+08:00'),
    fail = false;
  const create = () => {
    const markets = SYMBOLS.map((s) => parseMinute(minutePayload(s, 200e8, '20261028103030'), s));
    markets.forEach((m) => {
      m.breadth = { advancing: 500, unchanged: 0, declining: 500 };
      m.percent = 0;
    });
    const s = buildSnapshot(
      markets,
      SYMBOLS.map((symbol) => parseHistory(historyPayload(symbol), symbol)),
      now
    );
    s.sameTime = { current: 1, previous: 1, delta: 0, percent: 0 };
    s.comparisonTime = '10:30';
    return s;
  };
  const c = new TurnoverController(
    h.context,
    {
      load: async () => {
        if (fail) throw new Error('断网');
        return create();
      }
    },
    () => now
  );
  c.lastDate = DATE;
  c.lastPhase = 'trading';
  try {
    await c.refresh();
    assert.equal(c.temperatureHistory.points.length, 1);
    c.showTemperature();
    c.showTemperature();
    assert.equal(h.panels.length, 1);
    const chart = c.temperatureChart.state,
      panel = chart.panel;
    panel.webview.receive.fire({ action: 'ready', token: 'wrong' });
    assert.equal(panel.webview.messages.length, 0);
    panel.webview.receive.fire({ action: 'ready', token: chart.token });
    assert.equal(panel.webview.messages.at(-1).data.points.length, 1);
    const sent = panel.webview.messages.length;
    now = new Date('2026-10-28T10:30:31+08:00');
    await c.tick();
    c.render();
    assert.equal(c.temperatureHistory.points.length, 1);
    assert.equal(panel.webview.messages.length, sent);
    fail = true;
    now = new Date('2026-10-28T10:30:40+08:00');
    await c.refresh();
    assert.equal(c.temperatureHistory.points.length, 1);
    assert.equal(panel.webview.messages.at(-1).data.current.score, null);
    fail = false;
    now = new Date('2026-10-28T10:31:00+08:00');
    await c.refresh();
    assert.equal(c.temperatureHistory.points.length, 2);
    panel.setVisible(false);
    const hidden = panel.webview.messages.length;
    c.render();
    assert.equal(panel.webview.messages.length, hidden);
    panel.setVisible(true);
    assert.equal(panel.webview.messages.at(-1).data.points.length, 2);
    await c.togglePause();
    assert.equal(c.temperatureHistory.points.length, 2);
    assert.match(panel.webview.messages.at(-1).data.current.label, /暂停/);
    now = new Date('2026-10-29T09:00:00+08:00');
    c.render();
    assert.equal(panel.webview.messages.at(-1).data.points.length, 0);
    assert.equal(panel.webview.messages.at(-1).data.date, '2026-10-29');
    panel.dispose();
    c.showTemperature();
    assert.equal(h.panels.length, 2);
    assert.doesNotMatch(h.panels[1].webview.html, /iframe|https?:\/\/|unsafe-inline|eval\(/);
  } finally {
    c.dispose();
  }
});

test('旧10秒记录自动按分钟整理，移除午休和盘后快照，重启不会反复补回', async () => {
  const store = memory();
  store.values.set('temperatureHistory', {
    version: 1,
    model: 1,
    date: DATE,
    points: [
      point('10:30:10', 61),
      point('10:30:20', 62),
      point('10:31:00', 60),
      { ...point('12:00:00', 59), phase: '午休' },
      point('14:59:50', 45),
      { ...point('15:00:10', 43), phase: '收盘确认' },
      { ...point('15:01:10', 44), phase: '收盘确认' },
      { ...point('16:52:37', 44), phase: '已收盘' }
    ]
  });
  const history = new TemperatureHistory(store, DATE);
  assert.deepEqual(
    history.points.map((p) => p.time),
    ['10:30:20', '10:31:00', '14:59:50', '15:01:10']
  );
  assert.equal(history.points[0].score, 62);
  await history.flush();
  assert.equal(store.values.get('temperatureHistory').version, 2);
  assert.deepEqual(new TemperatureHistory(store, DATE).points, history.points);
  assert.equal(history.record({ ...result(44), phase: '已收盘' }, point('17:00:00').sampledAt), false);
});

test('午休不采集，收盘确认每分钟更新同一端点，保留实际时间', async () => {
  const history = new TemperatureHistory(memory(), DATE);
  assert.equal(history.record({ ...result(50), phase: '午休' }, point('12:00:00').sampledAt), false);
  for (const [time, score] of [
    ['14:59:50', 48],
    ['15:00:10', 46],
    ['15:01:10', 45]
  ])
    assert.equal(
      history.record(
        { ...result(score), phase: time.startsWith('15:') ? '收盘确认' : '交易中' },
        point(time).sampledAt
      ),
      true
    );
  assert.deepEqual(
    history.points.map((p) => p.time),
    ['14:59:50', '15:01:10']
  );
  assert.equal(history.record({ ...result(44), phase: '收盘确认' }, point('15:01:20').sampledAt), false);
  assert.equal(nearest(history.points, seconds('15:00:00')), 1);
  await history.flush();
});
