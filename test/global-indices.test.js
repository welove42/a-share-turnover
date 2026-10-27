'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
const { DEFAULT_INDICES } = require('../src/global-index-data');
function response(date = '2026-10-26T23:00:00+08:00', price = 12345.67) {
  return { entries: new Map(DEFAULT_INDICES.map(entry => [entry.id, entry])), errors: new Map(),
    quotes: new Map(DEFAULT_INDICES.map(entry => [entry.id, { ...entry, price, percent: 1.25, delta: 123, open: 12000, previousClose: 12222.67, high: 12500, low: 11900, timestamp: Date.parse(date) / 1000 }])) };
}
function setup(load, config = {}) {
  const h = harness(config); let now = new Date('2026-10-26T23:00:10+08:00'), calls = 0;
  const { GlobalIndicesController } = h.load('../src/global-indices');
  const c = new GlobalIndicesController(h.context, { now: () => now, provider: { load: async signal => { calls++; return load ? load(signal) : response(); } } });
  return { ...h, c, calls: () => calls, setNow: value => { now = new Date(value); } };
}
test('地区分组稳定，自选栏目下方的指数行显示点位涨跌及北京时间，隔夜收盘不伪装成今天', async () => {
  const h = setup(); try {
    await h.c.refresh(); const asia = h.c.getChildren()[0], rows = h.c.getChildren(asia);
    assert.equal(h.c.getChildren(asia)[0], rows[0]); assert.equal(h.c.getParent(rows[0]), asia);
    assert.match(h.c.getTreeItem(rows[0]).label, /\+1.25%.*12345.67.*日经225/);
    assert.equal(h.c.getTreeItem(rows[0]).iconPath.color.id, 'charts.red');
    h.setNow('2026-10-27T09:00:00+08:00');
    const nasdaq = h.c.getTreeItem(h.c.element('100.NDX'));
    assert.match(nasdaq.description, /10-26 23:00/); assert.match(nasdaq.tooltip.value, /北京时间/); assert.doesNotMatch(nasdaq.description, /实时/);
  } finally { h.c.dispose(); }
});
test('全球指数夜间及A股节假日仍按10秒刷新，隐藏和暂停停止，数据不变不重建行', async () => {
  const h = setup(); try {
    h.c.tree.visible = true; await h.c.tick(); assert.equal(h.calls(), 1); const events = h.c.emitter.fired.length;
    h.setNow('2026-10-26T23:00:19+08:00'); await h.c.tick(); assert.equal(h.calls(), 1);
    h.setNow('2026-10-26T23:00:20+08:00'); await h.c.tick(); assert.equal(h.calls(), 2); assert.equal(h.c.emitter.fired.length, events);
    h.setNow('2026-10-01T23:00:00+08:00'); h.c.lastAttempt = -Infinity; await h.c.tick(); assert.equal(h.calls(), 3);
    h.c.tree.visible = false; h.setNow('2026-10-27T23:00:00+08:00'); await h.c.tick(); assert.equal(h.calls(), 3);
    h.c.tree.visible = true; await h.c.togglePause(); await h.c.tick(); assert.equal(h.calls(), 3);
    assert.equal(h.store.get('globalIndicesPaused'), true); await h.c.togglePause(); assert.equal(h.calls(), 4);
  } finally { h.c.dispose(); }
});
test('失败及异常时间保留旧行情，恢复后清除失败标记；禁用不发请求', async () => {
  let mode = 'good';
  const h = setup(async () => { if (mode === 'fail') throw new Error('接口暂不可用'); return response(mode === 'future' ? '2027-01-01T00:00:00Z' : '2026-10-26T23:00:00+08:00', mode === 'good' ? 12345.67 : 99999); });
  try {
    await h.c.refresh(); mode = 'fail'; await h.c.refresh();
    assert.equal(h.c.quotes.get('100.N225').price, 12345.67); assert.match(h.c.getTreeItem(h.c.element('100.N225')).description, /获取失败/);
    mode = 'future'; await h.c.refresh(); assert.equal(h.c.quotes.get('100.N225').price, 12345.67);
    mode = 'good'; await h.c.refresh(); assert.equal(h.c.errors.size, 0);
    await h.api.workspace.getConfiguration('aShareTurnover').update('globalIndices.enabled', false);
    const calls = h.calls(); await h.c.refresh(); assert.equal(h.calls(), calls); assert.deepEqual(h.c.getChildren(), []);
  } finally { h.c.dispose(); }
});
test('并发刷新合并；隐藏时取消旧请求，暂停后不重启排队的自动请求', async () => {
  const requests = []; const h = setup(signal => new Promise(resolve => requests.push({ signal, resolve })));
  try {
    h.c.tree.visible = true; const pending = h.c.refresh(); assert.equal(pending, h.c.refresh()); assert.equal(h.calls(), 1);
    h.c.tree.visible = false; h.c.tree.visibility.fire({ visible: false }); assert.equal(requests[0].signal.aborted, true);
    h.c.tree.visible = true; const queued = h.c.refresh(true); await h.c.togglePause();
    requests[0].resolve(response()); await pending; await queued;
    assert.equal(h.calls(), 1); assert.equal(h.c.quotes.size, 0);
  } finally { h.c.dispose(); }
});
test('搜索包含日经、KOSPI、纳指别名，选择自动定位；详情打开只允许已知指数', async () => {
  const h = setup(); try {
    let items, reveal;
    h.api.window.showQuickPick = async list => { items = list; return list.find(item => item.id === '100.NDX'); };
    h.c.tree.reveal = async (...args) => { reveal = args; };
    await h.c.search(); assert.match(items.find(item => item.id === '100.NDX').description, /美国.*纳指/);
    assert.ok(items.some(item => item.label === '日经225')); assert.ok(items.some(item => item.description.includes('KS11')));
    assert.equal(reveal[0], h.c.element('100.NDX')); assert.equal(reveal[1].expand, true);
    await h.c.open(reveal[0]); assert.equal(h.opened[0], 'https://quote.eastmoney.com/gb/zsNDX.html');
    await h.c.open('https://evil.example'); assert.equal(h.opened.length, 1);
  } finally { h.c.dispose(); }
});
test('重启读取全球指数缓存并标注，缺失指数保留旧数据而非删除', async () => {
  const h = harness(); h.store.set('globalIndexQuotes', [...response().quotes.values()]);
  const { GlobalIndicesController } = h.load('../src/global-indices');
  const c = new GlobalIndicesController(h.context, { now: () => new Date('2026-10-26T23:01:00+08:00'), provider: { load: async () => {
    const result = response(); result.entries.delete('100.N225'); result.quotes.delete('100.N225'); return result;
  } } });
  try {
    assert.match(c.getTreeItem(c.element('100.N225')).description, /缓存/); await c.refresh();
    assert.equal(c.quotes.get('100.N225').price, 12345.67); assert.match(c.getTreeItem(c.element('100.N225')).description, /获取失败/);
  } finally { c.dispose(); }
});
