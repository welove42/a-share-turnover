'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
const { DEFAULT_COMMODITY_CODES, parseCommodityQuotes } = require('../src/commodity-data');
function response(codes, time = '13:50:00', price = '110.125') {
  return parseCommodityQuotes(codes.map(code => `var hq_str_hf_${code}="${price},,110,111,112,108,${time},100,109,0,0,0,2026-10-27,测试";`).join('\n'), codes);
}
function setup(config = {}, load) {
  const h = harness(config); let now = new Date('2026-10-27T13:50:01+08:00'); const calls = [];
  const { CommoditiesController } = h.load('../src/commodities');
  const c = new CommoditiesController(h.context, { now: () => now, provider: { load: async (codes, signal) => { calls.push([...codes]); return load ? load(codes, signal) : response(codes); } } });
  return { ...h, c, calls, setNow: value => { now = new Date(value); } };
}
test('新栏目只显示默认四个商品，含真实精度、单位、时间、CFD口径与选中色图标', async () => {
  const h = setup(); try {
    await h.c.refresh(); assert.deepEqual(h.calls, [DEFAULT_COMMODITY_CODES]);
    assert.deepEqual(h.c.getChildren().map(item => item.code), DEFAULT_COMMODITY_CODES);
    const element = h.c.element('CAD'), item = h.c.getTreeItem(element);
    assert.equal(h.c.getChildren()[2], element); assert.equal(h.c.getParent(element), undefined);
    assert.match(item.label, /\+10.13%.*110.125.*伦敦铜/); assert.match(item.description, /美元\/吨.*10-27 13:50:00/);
    assert.match(item.tooltip.value, /CFD.*非交易所逐笔成交价/); assert.match(item.iconPath.dark, /trend-up-dark.svg$/);
    await h.c.open(element); assert.equal(h.opened[0], 'https://finance.sina.com.cn/futures/quotes/CAD.shtml');
    await h.c.open('https://evil.test'); assert.equal(h.opened.length, 1);
  } finally { h.c.dispose(); }
});
test('展开每10秒刷新，不受A股休市限制，隐藏暂停禁用与空列表不请求且不变不重绘', async () => {
  const h = setup(); try {
    h.c.start(); await h.c.tick(); assert.equal(h.calls.length, 0);
    h.c.tree.visible = true; await h.c.tick(); assert.equal(h.calls.length, 1); const events = h.c.emitter.fired.length;
    h.setNow('2026-10-27T13:50:10+08:00'); await h.c.tick(); assert.equal(h.calls.length, 1);
    h.setNow('2026-10-27T13:50:11+08:00'); await h.c.tick(); assert.equal(h.calls.length, 2); assert.equal(h.c.emitter.fired.length, events);
    h.setNow('2026-10-27T23:50:00+08:00'); await h.c.tick(); assert.equal(h.calls.length, 3);
    h.c.tree.visible = false; h.setNow('2026-10-28T01:50:00+08:00'); await h.c.tick(); assert.equal(h.calls.length, 3);
    h.c.tree.visible = true; await h.c.togglePause(); await h.c.tick(); assert.equal(h.calls.length, 3); assert.equal(h.store.get('commoditiesPaused'), true);
    await h.c.refresh(); assert.equal(h.calls.length, 4); assert.equal(h.c.paused, true);
    await h.api.workspace.getConfiguration('aShareTurnover').update('commodities.enabled', false); await h.c.refresh(); assert.equal(h.calls.length, 4);
    await h.api.workspace.getConfiguration('aShareTurnover').update('commodities.enabled', true);
    await h.c.saveSelection([]); await h.c.refresh(); assert.equal(h.calls.length, 4); assert.deepEqual(h.c.getChildren(), []);
  } finally { h.c.dispose(); }
});
test('选中行的＋仍打开名称代码候选，多选去重保存，取消不修改，未选择品种不请求', async () => {
  const h = setup(); try {
    h.c.paused = true; h.api.window.showQuickPick = async (items, options) => {
      assert.equal(items.length, 14); assert.equal(options.canPickMany, true); assert.equal(options.matchOnDescription, true);
      assert.match(items.find(item => item.code === 'OIL').description, /布油.*Brent/);
      return [items.find(item => item.code === 'NG'), items.find(item => item.code === 'XAU')];
    };
    await h.c.add(h.c.element('XAU')); assert.deepEqual(h.c.codes, [...DEFAULT_COMMODITY_CODES, 'NG']);
    assert.deepEqual(h.values.get('aShareTurnover.commodities.symbols'), h.c.codes); assert.equal(h.calls.length, 0);
    h.api.window.showQuickPick = async () => undefined; await h.c.add(); assert.equal(h.c.codes.length, 5);
    await h.c.add('hf_cl'); assert.equal(h.c.codes.at(-1), 'CL'); await h.c.add('EVIL'); assert.equal(h.c.codes.length, 6);
    await h.c.refresh(); assert.deepEqual(h.calls[0], [...DEFAULT_COMMODITY_CODES, 'NG', 'CL']);
  } finally { h.c.dispose(); }
});
test('删除默认项及空列表重启不补回，设置只读时仍持久保存选择，缓存标注来源时间', async () => {
  const h = setup(); let restored; try {
    await h.c.refresh(); h.c.paused = true;
    const original = h.api.workspace.getConfiguration;
    h.api.workspace.getConfiguration = (...args) => ({ ...original(...args), update: async () => { throw new Error('只读'); } });
    await h.c.remove('OIL'); await h.c.add('NG');
    const { CommoditiesController } = h.load('../src/commodities'); restored = new CommoditiesController(h.context);
    assert.deepEqual(restored.codes, ['XAU', 'CAD', 'XAG', 'NG']); assert.match(restored.getTreeItem(restored.element('XAU')).description, /缓存.*10-27/);
    restored.dispose(); restored = undefined;
    for (const code of [...h.c.codes]) await h.c.remove({ code });
    restored = new CommoditiesController(h.context); assert.deepEqual(restored.codes, []);
    h.api.workspace.getConfiguration = original; await h.c.add('XAG'); assert.equal(Object.hasOwn(h.store.get('stockSettingsFallback'), 'commodities.symbols'), false);
  } finally { restored?.dispose(); h.c.dispose(); }
});
test('行情失败、缺项、未来及倒退时间保留旧值；成功后清除错误；负涨跌使用绿色图标', async () => {
  let mode = 'good'; const h = setup({}, async codes => {
    if (mode === 'fail') throw new Error('网络失败');
    const r = response(codes, mode === 'future' ? '18:00:00' : mode === 'older' ? '12:00:00' : '13:50:00', mode === 'down' ? '90.000' : mode === 'good' ? '110.125' : '999.999');
    if (mode === 'missing') r.quotes.delete('OIL'); return r;
  }); try {
    await h.c.refresh();
    for (const next of ['fail', 'missing', 'future', 'older']) { mode = next; await h.c.refresh(); assert.equal(h.c.quotes.get('OIL').priceText, '110.125'); assert.ok(h.c.errors.has('OIL')); }
    mode = 'down'; await h.c.refresh(); assert.equal(h.c.errors.size, 0); assert.match(h.c.getTreeItem(h.c.element('OIL')).iconPath.light, /trend-down-light.svg$/);
  } finally { h.c.dispose(); }
});
test('并发请求合并；改变选择、隐藏及暂停会取消旧请求，不让迟到结果覆盖新状态', async () => {
  const requests = []; const h = setup({}, (codes, signal) => new Promise(resolve => requests.push({ codes, signal, resolve })));
  try {
    h.c.tree.visible = true; const first = h.c.refresh(); assert.equal(first, h.c.refresh());
    await h.c.saveSelection(['XAU']); assert.equal(requests[0].signal.aborted, true);
    const queued = h.c.refresh(true); await h.c.togglePause(); requests[0].resolve(response(requests[0].codes)); await first; await queued;
    assert.equal(h.calls.length, 1); assert.equal(h.c.quotes.size, 0); assert.deepEqual(h.c.codes, ['XAU']);
    const manual = h.c.refresh(); h.c.tree.visible = false; h.c.tree.visibility.fire({ visible: false }); assert.equal(requests[1].signal.aborted, true);
    requests[1].resolve(response(['XAU'])); await manual; assert.equal(h.c.quotes.size, 0);
  } finally { h.c.dispose(); }
});
