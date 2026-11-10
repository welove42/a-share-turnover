const test = require('node:test');
const assert = require('node:assert/strict');
const { LimitAlertTracker } = require('../dist/features/watchlist/limit-alerts.js');
const start = Date.parse('2026-11-04T10:30:00+08:00');
function quote(price, seconds = 0, extra = {}) {
  const date = new Date(start + seconds * 1000 + 8 * 3600000).toISOString();
  return {
    symbol: 'sh600105',
    name: '测试股',
    price,
    priceText: price.toFixed(2),
    previousClose: 10,
    percent: (price / 10 - 1) * 100,
    high: 11,
    low: 9,
    limitUp: 11,
    limitDown: 9,
    date: date.slice(0, 10),
    timestamp: date.slice(0, 19).replace(/[-:T]/g, ''),
    ...extra
  };
}
const observe = (tracker, price, seconds = 0, extra = {}) =>
  tracker.observe(quote(price, seconds, extra), start + seconds * 1000);

test('只有触及真实限价才提醒，差一分钱不算；四类状态变化准确', () => {
  const t = new LimitAlertTracker();
  assert.deepEqual(observe(t, 10.99), []);
  assert.deepEqual(observe(t, 11, 10), ['limitUp']);
  assert.deepEqual(observe(t, 11, 20), []);
  assert.deepEqual(observe(t, 10.99, 30), ['limitUpOpened']);
  assert.deepEqual(observe(t, 9.01, 40), []);
  assert.deepEqual(observe(t, 9, 50), ['limitDown']);
  assert.deepEqual(observe(t, 9.01, 60), ['limitDownOpened']);
  assert.deepEqual(observe(t, 11, 70), ['limitUp']);
  assert.deepEqual(observe(t, 9, 80), ['limitUpOpened', 'limitDown']);
});

test('按源限价适配主板、创业板、科创板、北交所及分钱取整，不使用固定百分比', () => {
  for (const [symbol, type, previousClose, limitUp, limitDown] of [
    ['sh600105', 'GP-A', 7.43, 8.17, 6.69],
    ['sz000001', 'GP-A', 10, 11, 9],
    ['sz300750', 'GP-A-CYB', 10, 12, 8],
    ['sh688981', 'GP-A-KCB', 10, 12, 8],
    ['bj920002', 'GP', 10, 13, 7],
    ['bj830799', 'GP', 10, 13, 7]
  ]) {
    const t = new LimitAlertTracker(),
      extra = { symbol, securityType: type, previousClose, limitUp, limitDown, high: limitUp, low: limitDown };
    assert.deepEqual(observe(t, limitUp, 0, extra), ['limitUp'], symbol);
    assert.deepEqual(observe(t, limitDown, 10, extra), ['limitUpOpened', 'limitDown'], symbol);
  }
});

test('港美股、ETF、指数、B股、债券和新股特殊简称不会触发涨跌停', () => {
  for (const symbol of [
    'hk00700',
    'usAAPL',
    'sh510300',
    'sz159915',
    'sh000001',
    'sz399001',
    'sh900901',
    'sz200001',
    'sz123001',
    'bj999999'
  ]) {
    assert.deepEqual(observe(new LimitAlertTracker(), 11, 0, { symbol }), [], symbol);
  }
  for (const extra of [{ securityType: 'ETF' }, { securityType: 'ZS' }, { name: 'N新股票' }, { name: 'C新股票' }])
    assert.deepEqual(observe(new LimitAlertTracker(), 11, 0, extra), []);
});

test('缺失、不设限、限价反转、价格越界和异常精度不猜测涨跌停', () => {
  for (const extra of [
    { limitUp: null },
    { limitDown: undefined },
    { limitUp: -1 },
    { limitDown: 0 },
    { limitUp: 9, limitDown: 11 },
    { limitUp: 10 },
    { price: 11.01 },
    { previousClose: null },
    { high: 11.01 },
    { low: 8.99 },
    { price: 10.999 },
    { limitUp: Infinity },
    { limitDown: NaN }
  ])
    assert.deepEqual(observe(new LimitAlertTracker(), 11, 0, extra), [], JSON.stringify(extra));
});

test('不从高低价追溯开板，不跨重复/倒序报价、缺采、日期和限价变化拼事件', () => {
  let t = new LimitAlertTracker();
  assert.deepEqual(observe(t, 10), []); // 当天已经摸过上下限也不能凭高低价推断曾封板。
  observe(t, 11, 10);
  assert.deepEqual(t.observe(quote(10, 10), start + 20000), []);
  assert.deepEqual(t.observe(quote(10, 0), start + 20000), []);
  assert.deepEqual(observe(t, 10, 150), []);
  observe(t, 11, 160);
  assert.deepEqual(observe(t, 10, 86400), []);
  t = new LimitAlertTracker();
  observe(t, 11);
  assert.deepEqual(observe(t, 10, 10, { limitUp: 12, limitDown: 8 }), []);
  observe(t, 11, 20);
  t.clear('sh600105');
  assert.deepEqual(observe(t, 10, 30), []);
});

test('盘前试算、未来时间、过期数据不能建立可触发开板的状态', () => {
  for (const [stamp, now] of [
    ['20261104093001', '2026-11-04T09:30:00+08:00'],
    ['20261104092500', '2026-11-04T09:25:00+08:00'],
    ['20261104103000', '2026-11-04T10:33:00+08:00'],
    ['20261104126000', '2026-11-04T13:00:00+08:00']
  ]) {
    const t = new LimitAlertTracker();
    assert.deepEqual(t.observe(quote(11, 0, { timestamp: stamp }), Date.parse(now)), []);
    assert.deepEqual(observe(t, 10, 10), []);
  }
});
