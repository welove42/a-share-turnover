'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
const { BUILTIN_INDICES, DEFAULT_INDEX_IDS } = require('../src/global-index-data');
function response(date = '2026-10-26T23:00:00+08:00', price = 12345.67) {
  return { entries: new Map(BUILTIN_INDICES.map(entry => [entry.id, entry])), errors: new Map(),
    quotes: new Map(BUILTIN_INDICES.map(entry => [entry.id, { ...entry, price, percent: 1.25, delta: 123, open: 12000, previousClose: 12222.67, high: 12500, low: 11900, timestamp: Date.parse(date) / 1000 }])) };
}
function setup(load, config = {}) {
  const h = harness(config); let now = new Date('2026-10-26T23:00:10+08:00'), calls = 0;
  const { GlobalIndicesController } = h.load('../src/global-indices');
  const c = new GlobalIndicesController(h.context, { now: () => now, provider: { load: async (ids, signal) => { calls++; return load ? load(signal, ids) : response(); } } });
  return { ...h, c, calls: () => calls, setNow: value => { now = new Date(value); } };
}
test('默认平铺三个指数；完整行情目录不自动填满列表，隔夜报价保留真实时间', async () => {
  const h = setup(); try {
    await h.c.refresh(); const rows = h.c.getChildren();
    assert.deepEqual(rows.map(item => item.id), ['100.NDX', '100.N225', '100.KS11']);
    assert.equal(h.c.getChildren()[0], rows[0]); assert.equal(h.c.getParent(rows[0]), undefined);
    assert.deepEqual(h.c.getChildren(rows[0]), []);
    assert.match(h.c.getTreeItem(rows[1]).label, /\+1.25%.*12345.67.*日经225/);
    assert.equal(h.c.getTreeItem(rows[0]).iconPath.dark, 'file:///extension/media/trend-up-dark.svg');
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
test('添加可按名称代码别名检索；多选追加并去重，详情打开只允许已知指数', async () => {
  const h = setup(); try {
    let items, options;
    h.api.window.showQuickPick = async (list, opts) => { items = list; options = opts; return [list.find(item => item.id === '100.NDX'), list.find(item => item.id === '100.SPX')]; };
    await h.c.add(); assert.match(items.find(item => item.id === '100.NDX').description, /美国.*纳指.*已添加/);
    assert.ok(items.some(item => item.label === '日经225')); assert.ok(items.some(item => item.description.includes('KS11')));
    assert.equal(options.canPickMany, true);
    assert.deepEqual(h.c.getChildren().map(item => item.id), [...DEFAULT_INDEX_IDS, '100.SPX']);
    assert.deepEqual(h.values.get('aShareTurnover.globalIndices.symbols'), [...DEFAULT_INDEX_IDS, '100.SPX']);
    await h.c.open(h.c.element('100.NDX')); assert.equal(h.opened[0], 'https://quote.eastmoney.com/gb/zsNDX.html');
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
    assert.deepEqual(c.getChildren().map(item => item.id), DEFAULT_INDEX_IDS);
    assert.match(c.getTreeItem(c.element('100.N225')).description, /缓存/); await c.refresh();
    assert.equal(c.quotes.get('100.N225').price, 12345.67); assert.match(c.getTreeItem(c.element('100.N225')).description, /获取失败/);
  } finally { c.dispose(); }
});

test('手动增删顺序持久化，删除默认项与空列表重启后不会被目录重新填满', async () => {
  const h = setup(); let restored;
  try {
    h.c.paused = true;
    await h.c.add(['SPX', '100.NDX', '100.SPX']);
    await h.c.remove('N225');
    assert.deepEqual(h.c.selectedIds, ['100.NDX', '100.KS11', '100.SPX']);
    const { GlobalIndicesController } = h.load('../src/global-indices');
    restored = new GlobalIndicesController(h.context);
    assert.deepEqual(restored.getChildren().map(item => item.id), ['100.NDX', '100.KS11', '100.SPX']);
    restored.dispose(); restored = undefined;
    for (const id of [...h.c.selectedIds]) await h.c.remove({ id });
    await h.c.refresh(); assert.deepEqual(h.c.getChildren(), []);
    restored = new GlobalIndicesController(h.context);
    assert.deepEqual(restored.getChildren(), []);
    h.c.tree.visible = true; h.c.paused = false; h.c.lastAttempt = -Infinity;
    const calls = h.calls(); await h.c.tick(); assert.equal(h.calls(), calls);
  } finally { restored?.dispose(); h.c.dispose(); }
});
test('选中行时点击＋仍打开添加菜单，取消不修改列表；未知代码不加入', async () => {
  const h = setup(); try {
    let opened = 0;
    h.api.window.showQuickPick = async () => { opened++; return undefined; };
    await h.c.add(h.c.element('100.NDX'));
    assert.equal(opened, 1); assert.deepEqual(h.c.selectedIds, DEFAULT_INDEX_IDS);
    await h.c.add('UNKNOWN'); assert.deepEqual(h.c.selectedIds, DEFAULT_INDEX_IDS);
    assert.match(h.opened.at(-1).error, /未找到指数/);
    assert.equal(h.values.has('aShareTurnover.globalIndices.symbols'), false);
  } finally { h.c.dispose(); }
});
test('用户设置不可写时仍持久保存指数选择，重启不丢失，恢复可写后清理备用值', async () => {
  const h = setup(); let restored;
  try {
    const original = h.api.workspace.getConfiguration;
    h.api.workspace.getConfiguration = (...args) => ({ ...original(...args), update: async () => { throw new Error('设置只读'); } });
    await h.c.add('SPX'); await h.c.remove('KS11');
    const { GlobalIndicesController } = h.load('../src/global-indices');
    restored = new GlobalIndicesController(h.context);
    assert.deepEqual(restored.selectedIds, ['100.NDX', '100.N225', '100.SPX']);
    h.api.workspace.getConfiguration = original;
    await h.c.add('HSI');
    assert.deepEqual(h.values.get('aShareTurnover.globalIndices.symbols'), ['100.NDX', '100.N225', '100.SPX', '100.HSI']);
    assert.equal(Object.hasOwn(h.store.get('stockSettingsFallback'), 'globalIndices.symbols'), false);
  } finally { restored?.dispose(); h.c.dispose(); }
});
test('完整目录内未选择指数的故障不影响列表提示，直接修改设置及时同步选择', async () => {
  const h = setup(async () => { const result = response(); result.errors.set('100.SPX', '接口错误'); return result; });
  try {
    await h.c.refresh(); assert.equal(h.c.tree.message, undefined);
    await h.api.workspace.getConfiguration('aShareTurnover').update('globalIndices.symbols', ['SPX', 'ndx']);
    await h.c.refresh();
    assert.deepEqual(h.c.getChildren().map(item => item.id), ['100.SPX', '100.NDX']);
    assert.match(h.c.tree.message, /1 个指数未更新/);
    await h.api.workspace.getConfiguration('aShareTurnover').update('globalIndices.symbols', []);
    assert.deepEqual(h.c.getChildren(), []); assert.match(h.c.tree.message, /点击右上角＋/);
  } finally { h.c.dispose(); }
});

test('只刷新所选指数；目录失败不污染行情，候选仍可使用且目录请求会冷却', async () => {
  let ids, catalogCalls = 0; const h = setup((signal, selected) => { ids = selected; return response(); });
  h.c.provider.loadCatalog = async () => { catalogCalls++; throw new Error('目录连接断开'); };
  try {
    await h.c.refresh(); assert.deepEqual(ids, DEFAULT_INDEX_IDS); assert.equal(catalogCalls, 0);
    h.api.window.showQuickPick = async items => { assert.ok(items.find(item => item.id === '100.SPX')); return undefined; };
    await h.c.add(); await h.c.add(); assert.equal(catalogCalls, 1); assert.equal(h.c.errors.size, 0); assert.equal(h.c.tree.message, undefined);
    await h.c.saveSelection([]); const calls = h.calls(); await h.c.refresh(); assert.equal(h.calls(), calls);
  } finally { h.c.dispose(); }
});
test('全源失败按20、40、60秒退避，手动刷新可立即重试，恢复后重回10秒', async () => {
  let failing = true; const h = setup(() => { if (failing) throw new Error('所有源断开'); return response(); });
  try {
    h.c.tree.visible = true; await h.c.tick(); assert.equal(h.c.pollDelay, 20000);
    h.setNow('2026-10-26T23:00:20+08:00'); await h.c.tick(); assert.equal(h.calls(), 1);
    h.setNow('2026-10-26T23:00:30+08:00'); await h.c.tick(); assert.equal(h.calls(), 2); assert.equal(h.c.pollDelay, 40000);
    h.setNow('2026-10-26T23:01:10+08:00'); await h.c.tick(); assert.equal(h.c.pollDelay, 60000); assert.match(h.c.tree.description, /60秒/);
    failing = false; await h.c.refresh(); assert.equal(h.c.pollDelay, 10000); assert.equal(h.c.errors.size, 0);
  } finally { h.c.dispose(); }
});
test('切换来源区分更新时间与成交时间，不误判同日旧时钟；同源倒退仍保留原值', async () => {
  let source = 'sina', timestamp = Date.parse('2026-10-26T23:00:00+08:00') / 1000;
  const h = setup(() => { const r = response(); for (const q of r.quotes.values()) Object.assign(q, { source, timestampKind: source === 'sina' ? 'updated' : 'quote', timestamp }); return r; });
  try {
    await h.c.refresh(); assert.match(h.c.getTreeItem(h.c.element('100.NDX')).description, /备用/); assert.match(h.c.getTreeItem(h.c.element('100.NDX')).tooltip.value, /来源更新时间.*\n来源：新浪财经/);
    source = 'eastmoney'; timestamp -= 1800; await h.c.refresh(); assert.equal(h.c.errors.size, 0); assert.equal(h.c.quotes.get('100.NDX').source, 'eastmoney');
    source = 'sina'; timestamp -= 60; await h.c.refresh(); assert.ok(h.c.errors.has('100.NDX')); assert.equal(h.c.quotes.get('100.NDX').source, 'eastmoney');
  } finally { h.c.dispose(); }
});
test('修改已选指数时取消旧请求，迟到响应不会重新写入已移除项', async () => {
  const requests = []; const h = setup((signal, ids) => new Promise(resolve => requests.push({ signal, ids, resolve })));
  try {
    h.c.tree.visible = true; const first = h.c.refresh(); await h.c.saveSelection(['NDX']);
    assert.equal(requests[0].signal.aborted, true); requests[0].resolve(response()); await first;
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(requests[1].ids, ['100.NDX']);
    assert.equal(h.c.quotes.size, 0); requests[1].resolve(response()); await h.c.inflight;
    assert.deepEqual([...h.c.quotes.keys()], ['100.NDX']);
  } finally { h.c.dispose(); }
});
