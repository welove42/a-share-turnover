'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseExtended, parseTime, usClock, validExtended, UsExtendedProvider, sinaCode } = require('../src/us-extended');
const { harness } = require('./vscode-mock');
const NOW = new Date('2026-11-05T11:30:00Z');
function line({ symbol = 'usAAPL', price = '102.0000', base = '100.0000', closingBase = base, delta = '2.00', percent = '2.00', extendedTime = 'Nov 05 06:30AM EST', regularTime = 'Nov 04 04:00PM EST', update = '2026-11-05 19:30:00', year = '2026' } = {}) {
  const f = Array(36).fill('0'); f[0] = symbol === 'usAAPL' ? '苹果' : '测试'; f[1] = base; f[3] = update; f[21] = price; f[22] = percent; f[23] = delta; f[24] = extendedTime; f[25] = regularTime; f[26] = '80'; f[29] = year; f[35] = closingBase;
  return `var hq_str_${sinaCode(symbol)}="${f.join(',')}";`;
}
function regularLine(symbol = 'usAAPL', timestamp = '2026-11-04 16:00:01', percent = '25.00') {
  const f = Array(40).fill('0'); f[1] = '常规名称'; f[2] = symbol.slice(2); f[3] = '100.00'; f[4] = '80.00'; f[30] = timestamp; f[31] = '20.00'; f[32] = percent; f[33] = '101'; f[34] = '79';
  return `v_${symbol}="${f.join('~')}";`;
}
function setup(options = {}) {
  const h = harness({ 'aShareTurnover.stocks.usSymbols': ['usAAPL', 'usTSLA'], ...options });
  const { WatchlistController } = h.load('../src/watchlist'); let now = NOW, requests = 0, regular = regularLine() + regularLine('usTSLA');
  let extended = line() + line({ symbol: 'usTSLA', price: '95', delta: '-5', percent: '-5' });
  const c = new WatchlistController(h.context, { now: () => now, provider: { load: async () => ({ quotes: new Map(), errors: new Map() }) } });
  c.overseas.request = async () => regular;
  c.overseas.extendedProvider = new UsExtendedProvider(async () => { requests++; if (extended instanceof Error) throw extended; return extended; });
  return { ...h, c, count: () => requests, setNow: value => { now = new Date(value); }, setExtended: value => { extended = value; }, setRegular: value => { regular = value; } };
}
test('独立解析盘前价格和涨跌幅，以常规收盘价为基准，保留真实美东报价时间', () => {
  const r = parseExtended(line(), ['usAAPL'], NOW), q = r.quotes.get('usAAPL');
  assert.equal(q.phase, 'pre'); assert.equal(q.percent, 2); assert.equal(q.basePrice, 100); assert.equal(q.priceText, '102');
  assert.equal(q.timestamp, '20261105063000'); assert.equal(q.epoch, NOW.getTime()); assert.equal(q.regularTimestamp, '20261104160000');
  assert.equal(validExtended(q, NOW), true); assert.equal(sinaCode('usBRK.B'), 'gb_brk$b');
  assert.equal(parseExtended(line({ symbol: 'usBRK.B' }), ['usBRK.B'], NOW).quotes.size, 1);
  const zero = parseExtended(line({ price: '100', delta: '0', percent: '0' }), ['usAAPL'], NOW); assert.equal(zero.quotes.get('usAAPL').percent, 0);
});
test('夏令时和冬令时正确换算，凌晨和20点边界不误当常规交易', () => {
  assert.equal(parseTime('Jul 08 08:15AM EDT', 2026).epoch, Date.parse('2026-07-08T12:15:00Z'));
  assert.equal(parseTime('Jul 08 08:15AM EST', 2026), null);
  assert.equal(parseTime('Feb 30 08:15AM EST', 2026), null);
  assert.equal(usClock(new Date('2026-07-08T08:00:00Z')).phase, 'pre');
  assert.equal(usClock(new Date('2026-11-05T09:00:00Z')).phase, 'pre');
  assert.equal(usClock(new Date('2026-11-05T14:30:00Z')).phase, 'regular');
  assert.equal(usClock(new Date('2026-11-05T21:00:00Z')).phase, 'post');
  assert.equal(usClock(new Date('2026-11-06T01:00:00Z')).quotePolling, true);
  assert.equal(usClock(new Date('2026-11-06T01:02:00Z')).quotePolling, false);
  assert.equal(usClock(new Date('2026-11-07T15:00:00Z')).phase, 'closed');
});
test('盘后支持跨北京时间日期、跨年基准，以及美股提前收盘', () => {
  const after = parseExtended(line({ extendedTime: 'Nov 05 07:30PM EST', regularTime: 'Nov 05 04:00PM EST', update: '2026-11-06 08:30:00' }), ['usAAPL'], new Date('2026-11-06T00:30:00Z')).quotes.get('usAAPL');
  assert.equal(after.phase, 'post'); assert.equal(after.date, '2026-11-05');
  const january = parseExtended(line({ extendedTime: 'Jan 02 06:30AM EST', regularTime: 'Dec 31 04:00PM EST', update: '2026-01-02 19:30:00' }), ['usAAPL'], new Date('2026-01-02T11:30:00Z')).quotes.get('usAAPL');
  assert.equal(january.regularTimestamp, '20251231160000');
  const early = parseExtended(line({ extendedTime: 'Nov 27 01:30PM EST', regularTime: 'Nov 27 01:00PM EST', update: '2026-11-28 02:30:00' }), ['usAAPL'], new Date('2026-11-27T18:30:00Z')).quotes.get('usAAPL');
  assert.equal(early.phase, 'post'); assert.equal(early.earlyClose, true);
});
test('盘前盘后使用源提供的收盘修正基准，兼容16:01发布的收盘记录', () => {
  const q = parseExtended(line({ symbol: 'usBRK.B', price: '582.1951', base: '579.09', closingBase: '579.665', delta: '2.53', percent: '0.44', regularTime: 'Nov 04 04:01PM EST' }), ['usBRK.B'], NOW).quotes.get('usBRK.B');
  assert.equal(q.basePrice, 579.665); assert.equal(q.percent, .44);
  const post = parseExtended(line({ extendedTime: 'Nov 05 04:00PM EST', regularTime: 'Nov 05 04:01PM EST', update: '2026-11-06 05:02:00' }), ['usAAPL'], new Date('2026-11-05T21:02:00Z')).quotes.get('usAAPL');
  assert.equal(post.phase, 'post'); assert.equal(post.regularTimestamp, '20261105160100');
});
test('拒绝错码、无效/未来时间、常规时段伪盘后、异常基准；无成交不伪造零涨幅', () => {
  assert.equal(parseExtended(line(), ['usMSFT'], NOW).quotes.size, 0);
  for (const change of [{ percent: '25' }, { delta: '30' }, { base: '0' }, { extendedTime: 'Nov 05 10:30AM EST' }, { extendedTime: 'Nov 06 06:30AM EST' }, { update: '2026-02-30 19:30:00' }]) assert.equal(parseExtended(line(change), ['usAAPL'], NOW).quotes.size, 0);
  const missing = parseExtended(line({ price: '0', extendedTime: '' }), ['usAAPL'], NOW); assert.equal(missing.quotes.size, 0); assert.equal(missing.unavailable.has('usAAPL'), true);
  const q = parseExtended(line(), ['usAAPL'], NOW).quotes.get('usAAPL');
  assert.equal(validExtended({ ...q, regularTimestamp: '20260230160000' }, NOW), false);
  assert.equal(validExtended(q, new Date('2026-11-20T11:30:00Z')), false);
});
test('美股行展示盘前，悬停同时保留常规；涨跌排序与显示一致且不改提醒的数据', async () => {
  const h = setup({ 'aShareTurnover.stocks.sortBy': 'percentAsc' }), { c } = h;
  try {
    await c.overseas.refresh('us'); const row = c.getTreeItem(c.overseas.element('usAAPL'));
    assert.match(row.label, /\+2.00%.*102.*苹果/); assert.equal(row.description, '盘前');
    assert.match(row.tooltip.value, /常规：100.00.*\+25.00%/); assert.match(row.tooltip.value, /盘前：102.*\+2.00%/);
    assert.match(row.tooltip.value, /常规收盘基准：100/); assert.match(row.tooltip.value, /06:30（美东时间，分钟精度）/); assert.match(row.tooltip.value, /盘后：暂无/);
    assert.equal(c.getChildren(c.overseas.groups.us)[0].symbol, 'usTSLA');
    assert.equal(c.overseas.quotes.get('usAAPL').percent, 25); // Existing regular-session alerts are unchanged.
    const restored = new (h.load('../src/watchlist').WatchlistController)(h.context, { now: () => NOW });
    try { assert.match(restored.overseas.displayInfo('usAAPL').description, /盘前.*缓存/); } finally { restored.dispose(); }
  } finally { c.dispose(); }
});
test('常规开盘切回常规价，盘后切换；两类报价分开缓存，过期盘前不冒充今天', async () => {
  const h = setup(), { c } = h;
  try {
    await c.overseas.refresh('us'); h.setNow('2026-11-05T15:00:00Z'); assert.equal(c.overseas.displayInfo('usAAPL').phase, 'regular');
    h.setNow('2026-11-05T22:00:00Z'); h.setRegular(regularLine('usAAPL', '2026-11-05 16:00:01'));
    h.setExtended(line({ extendedTime: 'Nov 05 05:00PM EST', regularTime: 'Nov 05 04:00PM EST', update: '2026-11-06 06:00:00', price: '97', delta: '-3', percent: '-3' }));
    await c.overseas.refresh('us'); assert.equal(c.overseas.displayInfo('usAAPL').phase, 'post');
    const slots = c.overseas.extended.get('usAAPL'); assert.equal(slots.pre.percent, 2); assert.equal(slots.post.percent, -3);
    h.setNow('2026-11-06T08:00:00Z'); assert.equal(c.overseas.displayInfo('usAAPL').phase, 'post');
    h.setNow('2026-11-06T11:00:00Z'); assert.match(c.overseas.displayInfo('usAAPL').description, /常规.*盘前暂无/);
  } finally { c.dispose(); }
});
test('盘前按10秒自动刷新，常规时段扩展行情降频，暂停和老板键阻止请求', async () => {
  const h = setup(), { c } = h;
  try {
    c.overseas.tick(); await c.overseas.inflight.us; assert.equal(h.count(), 1);
    h.setNow('2026-11-05T11:30:09Z'); c.overseas.tick(); assert.equal(h.count(), 1);
    h.setNow('2026-11-05T11:30:10Z'); c.overseas.tick(); await c.overseas.inflight.us; assert.equal(h.count(), 2);
    h.setNow('2026-11-05T14:30:00Z'); c.overseas.tick(); await c.overseas.inflight.us; assert.equal(h.count(), 3);
    h.setNow('2026-11-05T14:30:10Z'); c.overseas.tick(); await c.overseas.inflight.us; assert.equal(h.count(), 3);
    c.paused = true; h.setNow('2026-11-05T21:30:00Z'); c.overseas.tick(false); await c.overseas.refresh('us'); assert.equal(h.count(), 3);
    c.paused = false; c.setHidden(true); await c.overseas.refresh('us'); assert.equal(h.count(), 3);
  } finally { c.dispose(); }
});
test('扩展源失败保留报价和原时间，正常源独立可用；取消忽略迟到数据', async () => {
  const h = setup(), { c } = h;
  try {
    await c.overseas.refresh('us'); const original = c.overseas.extended.get('usAAPL').pre;
    h.setExtended(new Error('扩展源断网')); await c.overseas.refresh('us');
    assert.equal(c.overseas.extended.get('usAAPL').pre.timestamp, original.timestamp); assert.match(c.overseas.displayInfo('usAAPL').description, /缓存/);
    assert.equal(c.overseas.errors.size, 0); assert.match(c.getTreeItem(c.overseas.element('usAAPL')).tooltip.value, /扩展源断网/);
    let finish; c.overseas.extendedProvider = { load: () => new Promise(resolve => { finish = resolve; }) };
    const pending = c.overseas.refresh('us'); c.overseas.changed();
    finish({ quotes: new Map([['usAAPL', { ...original, price: 200 }]]), errors: new Map() }); await pending;
    assert.equal(c.overseas.extended.get('usAAPL').pre.price, 102);
  } finally { c.dispose(); }
});
