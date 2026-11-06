'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
const { holdingReturn } = require('../src/fund-data');
function quote(code = '110020', nav = 1.5, date = '2026-10-26') { return { code, name: '测试基金', type: '混合型', kind: 'nav', nav, cumulativeNav: 2.1, percent: .5, date }; }
function setup(config = {}, load, search) {
  const h = harness(config); let now = new Date('2026-10-27T11:00:00+08:00'), calls = 0; const requests = [];
  const { FundsController } = h.load('../src/funds');
  const c = new FundsController(h.context, { now: () => now, provider: {
    load: async (codes, signal) => { calls++; requests.push([...codes]); return load ? load(codes, signal) : { quotes: new Map(codes.map(code => [code, quote(code)])), errors: new Map() }; },
    search: search || (async () => [])
  } });
  return { ...h, c, calls: () => calls, requests, setNow: date => { now = new Date(date); } };
}
const config = { 'aShareTurnover.funds.symbols': ['110020'] };
const estimate = (extra = {}) => ({ code: '110020', name: '测试基金', nav: 1.53, percent: 2, time: '2026-10-27 11:00', baseDate: '2026-10-26', baseNav: 1.5, sourceHost: 'fundcomapi.eastmoney.com', ...extra });
const estimateResult = e => ({ estimates: new Map(e ? [[e.code, e]] : []), unavailable: new Set(e ? [] : ['110020']), errors: new Map() });

test('盘中自动显示估算净值与持仓，悬停同时保留正式净值；公布当日净值后自动切回', async () => {
  let official = quote(); const h = setup(config, async () => ({ quotes: new Map([['110020', official]]), errors: new Map() }));
  h.c.provider.loadEstimates = async () => estimateResult(estimate());
  try {
    await h.c.refresh(); await h.c.saveHolding('110020', { shares: 1000, cost: 1200 });
    let item = h.c.getTreeItem(h.c.element('110020'));
    assert.match(item.label, /估算.*\+2.00%.*1.5300/); assert.match(item.description, /10-27 11:00.*估算持仓 \+330.00/);
    assert.match(item.tooltip.value, /今日预估收益：\+30.00/); assert.match(item.tooltip.value, /单位净值：1.5000/); assert.match(item.tooltip.value, /持仓收益：\+300.00/);
    assert.match(item.tooltip.value, /不代表基金正式净值或实际收益/); assert.equal(h.c.quotes.get('110020').nav, 1.5);
    official = quote('110020', 1.52, '2026-10-27'); await h.c.refresh(); item = h.c.getTreeItem(h.c.element('110020'));
    assert.match(item.label, /净值.*1.5200/); assert.match(item.description, /持仓 \+320.00/); assert.doesNotMatch(item.description, /估算持仓/);
    assert.match(item.tooltip.value, /正式净值已公布/);
  } finally { h.c.dispose(); }
});

test('估值失败保留带缓存标记的近期估算，过期或跨日自动回退，明确无估值时不沿用旧值', async () => {
  let mode = 'ok'; const h = setup(config);
  h.c.provider.loadEstimates = async () => { if (mode === 'fail') throw new Error('估值接口断开'); return estimateResult(mode === 'empty' ? null : estimate()); };
  try {
    h.c.tree.visible = true; await h.c.refresh(); const saved = h.store.get('fundEstimates'); assert.equal(saved[0].time, '2026-10-27 11:00');
    mode = 'fail'; await h.c.refresh(); let item = h.c.getTreeItem(h.c.element('110020'));
    assert.match(item.label, /估算/); assert.match(item.description, /缓存/); assert.match(item.tooltip.value, /估值接口断开/); assert.equal(h.c.errors.size, 0);
    h.setNow('2026-10-27T11:16:00+08:00'); await h.c.tick(); item = h.c.getTreeItem(h.c.element('110020'));
    assert.match(item.label, /净值/); assert.match(item.tooltip.value, /超过15个交易分钟/);
    h.setNow('2026-10-28T11:00:00+08:00'); item = h.c.getTreeItem(h.c.element('110020')); assert.match(item.label, /净值/); assert.match(item.tooltip.value, /不是今日/);
    mode = 'empty'; await h.c.refresh(); assert.equal(h.c.estimates.has('110020'), false); assert.match(h.c.getTreeItem(h.c.element('110020')).tooltip.value, /数据源未提供/);
  } finally { h.c.dispose(); }
});

test('估值缺失、基准不符、时间倒退或未来值不影响正式净值；货币基金不参与估算', async () => {
  let value = estimate(); const h = setup(config); h.c.provider.loadEstimates = async () => estimateResult(value);
  try {
    await h.c.refresh(); value = estimate({ time: '2026-10-27 11:15' }); await h.c.refresh(); assert.equal(h.c.estimates.get('110020').time, '2026-10-27 11:00');
    value = estimate({ time: '2026-10-27 10:50' }); await h.c.refresh(); assert.equal(h.c.estimates.get('110020').time, '2026-10-27 11:00');
    value = estimate({ baseDate: '2026-10-23' }); await h.c.refresh(); assert.match(h.c.getTreeItem(h.c.element('110020')).label, /净值/);
    assert.match(h.c.getTreeItem(h.c.element('110020')).tooltip.value, /基准与正式净值不一致/);
    h.c.quotes.set('110020', { code: '110020', name: '货币基金', type: '货币型', kind: 'money', date: '2026-10-26', incomeUnit: 10000, incomePerUnit: .2, sevenDayYield: 1 });
    assert.equal(h.c.displayEstimate('110020'), undefined); assert.match(h.c.getTreeItem(h.c.element('110020')).label, /万份收益/);
  } finally { h.c.dispose(); }
});

test('估值批量轮询仅限可见时段，设置可关闭，暂停和老板键取消迟到数据', async () => {
  const h = setup(config); let requests = 0, resolveEstimate, signal;
  h.c.provider.loadEstimates = async (codes, s) => { requests++; assert.deepEqual(codes, ['110020']); return estimateResult(estimate()); };
  try {
    h.c.tree.visible = true; await h.c.refresh(); assert.equal(requests, 1);
    h.setNow('2026-10-27T11:00:59+08:00'); await h.c.tick(); assert.equal(requests, 1);
    h.setNow('2026-10-27T11:01:00+08:00'); await h.c.tick(); assert.equal(requests, 2);
    h.c.tree.visible = false; h.setNow('2026-10-27T11:02:00+08:00'); await h.c.tick(); assert.equal(requests, 2);
    await h.api.workspace.getConfiguration('aShareTurnover').update('funds.estimateEnabled', false); await h.c.refresh(); assert.equal(requests, 2); assert.equal(h.c.displayEstimate('110020'), undefined);
    await h.api.workspace.getConfiguration('aShareTurnover').update('funds.estimateEnabled', true);
    h.setNow('2026-10-31T11:00:00+08:00'); await h.c.refresh(); assert.equal(requests, 2);
    h.setNow('2026-10-27T11:03:00+08:00'); h.c.provider.loadEstimates = (codes, s) => { signal = s; return new Promise(resolve => { resolveEstimate = resolve; }); };
    const pending = h.c.refresh(); h.c.setHidden(true); assert.equal(signal.aborted, true);
    resolveEstimate(estimateResult(estimate({ time: '2026-10-27 11:03' }))); await pending;
    assert.equal(h.c.estimates.get('110020').time, '2026-10-27 11:00'); assert.deepEqual(h.c.getChildren(), []);
  } finally { h.c.dispose(); }
});

test('估值缓存重启可用但明确标记缓存，已保存的持仓不会发送给估值接口', async () => {
  const h = setup(config); h.c.provider.loadEstimates = async (codes, signal) => { assert.deepEqual(codes, ['110020']); assert.ok(signal instanceof AbortSignal); return estimateResult(estimate()); };
  let restored;
  try {
    await h.c.saveHolding('110020', { shares: 1000, cost: 1200 }); await h.c.refresh();
    const { FundsController } = h.load('../src/funds'); restored = new FundsController(h.context, { now: () => new Date('2026-10-27T11:01:00+08:00') });
    const item = restored.getTreeItem(restored.element('110020')); assert.match(item.label, /估算/); assert.match(item.description, /缓存.*估算持仓/);
    assert.equal(restored.holdings['110020'].shares, 1000); assert.deepEqual(Object.keys(h.store.get('fundEstimates')[0]).sort(), Object.keys(estimate()).sort());
  } finally { restored?.dispose(); h.c.dispose(); }
});
test('基金默认空列表不请求数据，完整代码添加去重并保存，行显示净值和真实日期', async () => {
  const h = setup(); try {
    await h.c.refresh(); assert.equal(h.calls(), 0); assert.deepEqual(h.c.getChildren(), []);
    await h.c.add('110020,000198,110020'); await h.c.refresh();
    assert.deepEqual(h.c.symbols, ['110020', '000198']); assert.deepEqual(h.values.get('aShareTurnover.funds.symbols'), h.c.symbols);
    const row = h.c.getTreeItem(h.c.element('110020')); assert.match(row.label, /\+0.50%.*1.5000/); assert.match(row.description, /2026-10-26/);
    assert.equal(row.iconPath.dark, 'file:///extension/media/trend-up-dark.svg'); assert.equal(h.c.getChildren()[0], h.c.element('110020'));
  } finally { h.c.dispose(); }
});
test('持仓两步输入原子保存，收益率使用总成本；取消第二步不改旧持仓且不发送给接口', async () => {
  const h = setup(config); try {
    await h.c.refresh(); let resolveCost, step = 0;
    h.api.window.showInputBox = async options => {
      assert.ok(options.validateInput('0')); assert.equal(options.validateInput('1000'), undefined);
      return ++step === 1 ? '1000' : new Promise(resolve => { resolveCost = resolve; });
    };
    const pending = h.c.editHolding({ code: '110020' }); await new Promise(r => setImmediate(r));
    assert.equal(h.store.has('fundHoldings'), false); resolveCost('1200'); await pending;
    const stored = h.store.get('fundHoldings')['110020']; assert.deepEqual(stored, { shares: 1000, cost: 1200 });
    const row = h.c.getTreeItem(h.c.element('110020')); assert.match(row.description, /持仓 \+300.00 \(\+25.00%\)/);
    assert.match(row.tooltip.value, /2026-10-26已公布净值/); assert.match(row.tooltip.value, /不包含已赎回部分/);
    assert.equal([...h.values.keys()].some(key => /holding|shares|cost/i.test(key)), false);
    assert.deepEqual(h.requests, [['110020']]);
    step = 0; h.api.window.showInputBox = async () => ++step === 1 ? '2000' : undefined;
    await h.c.editHolding('110020'); assert.deepEqual(h.store.get('fundHoldings')['110020'], stored);
  } finally { h.c.dispose(); }
});
test('本机持仓重启保留，移出再添加恢复，清除持仓保留关注；并发写入不丢记录', async () => {
  const h = setup({ 'aShareTurnover.funds.symbols': ['110020', '000001'] }); let restored;
  try {
    await Promise.all([h.c.saveHolding('110020', { shares: 100, cost: 100 }), h.c.saveHolding('000001', { shares: 200, cost: 200 })]);
    assert.equal(Object.keys(h.store.get('fundHoldings')).length, 2);
    await h.c.remove('110020'); assert.ok(h.store.get('fundHoldings')['110020']); await h.c.add('110020');
    const { FundsController } = h.load('../src/funds'); restored = new FundsController(h.context);
    assert.equal(restored.holdings['110020'].shares, 100); restored.dispose(); restored = undefined;
    await h.c.clearHolding('110020'); assert.equal(h.c.holdings['110020'], undefined); assert.ok(h.c.symbols.includes('110020'));
    assert.equal(h.c.holdings['000001'].shares, 200);
  } finally { restored?.dispose(); h.c.dispose(); }
});
test('货币基金显示收益口径并禁止按单位净值设置持仓，避免大额错误盈亏', async () => {
  const h = setup(config); try {
    h.c.quotes.set('110020', { code: '110020', name: '测试货币基金', type: '货币型', kind: 'money', date: '2026-10-26', incomeUnit: 10000, incomePerUnit: .2174, sevenDayYield: .841 });
    const row = h.c.getTreeItem(h.c.element('110020')); assert.match(row.label, /万份收益 0.2174/); assert.match(row.description, /七日年化 \+0.84%/);
    await h.c.editHolding('110020'); assert.equal(h.store.has('fundHoldings'), false); assert.match(h.opened.at(-1).error, /交易流水/);
  } finally { h.c.dispose(); }
});
test('可见时60秒检查净值，隐藏和暂停停止，不变的数据不重绘', async () => {
  const h = setup(config); try {
    h.c.tree.visible = true; await h.c.refresh(); const events = h.c.emitter.fired.length;
    h.setNow('2026-10-27T11:00:59+08:00'); await h.c.tick(); assert.equal(h.calls(), 1);
    h.setNow('2026-10-27T11:01:00+08:00'); await h.c.tick(); assert.equal(h.calls(), 2); assert.equal(h.c.emitter.fired.length, events);
    h.c.tree.visible = false; h.setNow('2026-10-27T11:02:00+08:00'); await h.c.tick(); assert.equal(h.calls(), 2);
    h.c.tree.visible = true; await h.c.togglePause(); await h.c.tick(); assert.equal(h.calls(), 2);
    await h.c.refresh(); assert.equal(h.calls(), 3); assert.equal(h.c.paused, true);
    await h.c.togglePause(); assert.equal(h.calls(), 4);
  } finally { h.c.dispose(); }
});
test('网络失败、未来或倒退的净值日期均保留旧行情和持仓收益，并标注错误', async () => {
  let mode = 'ok';
  const h = setup(config, async codes => {
    if (mode === 'fail') throw new Error('离线');
    return { quotes: new Map(codes.map(code => [code, quote(code, mode === 'ok' ? 1.5 : 9, mode === 'future' ? '2027-01-01' : mode === 'past' ? '2026-10-23' : '2026-10-26')])), errors: new Map() };
  });
  try {
    await h.c.refresh(); await h.c.saveHolding('110020', { shares: 100, cost: 100 });
    for (const value of ['fail', 'future', 'past']) { mode = value; await h.c.refresh(); assert.equal(holdingReturn(h.c.quotes.get('110020'), h.c.holdings['110020']).profit, 50); assert.match(h.c.getTreeItem(h.c.element('110020')).description, /获取失败/); }
    mode = 'ok'; await h.c.refresh(); assert.equal(h.c.errors.size, 0);
  } finally { h.c.dispose(); }
});
test('删除/禁用取消进行中请求，迟到结果不恢复基金；排队自动刷新会重新检查状态', async () => {
  const requests = [];
  const h = setup(config, (codes, signal) => new Promise(resolve => requests.push({ codes, signal, resolve })));
  try {
    h.c.tree.visible = true; const pending = h.c.refresh(); assert.equal(pending, h.c.refresh());
    await h.c.remove('110020'); assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ quotes: new Map([['110020', quote()]]), errors: new Map() }); await pending;
    assert.deepEqual(h.c.getChildren(), []); assert.equal(h.c.quotes.size, 0);
    await h.api.workspace.getConfiguration('aShareTurnover').update('funds.enabled', false);
    await h.c.refresh(); assert.equal(h.calls(), 1);
  } finally { h.c.dispose(); }
});
test('基金中文名搜索取消旧请求并忽略迟到结果，标题栏＋传入选中行仍打开搜索', async () => {
  const requests = [], h = setup(config, undefined, (query, signal) => new Promise(resolve => requests.push({ query, signal, resolve })));
  try {
    h.c.paused = true; const done = h.c.add(h.c.element('110020')); const picker = h.pickers[0]; assert.equal(picker.title, '搜索并添加基金');
    picker.change('沪深'); await new Promise(r => setTimeout(r, 330)); picker.change('华夏'); assert.equal(requests[0].signal.aborted, true);
    await new Promise(r => setTimeout(r, 330));
    requests[1].resolve([{ name: '华夏成长', code: '000001', type: '混合型', pinyin: 'HXCZ' }]); await new Promise(r => setImmediate(r));
    requests[0].resolve([{ name: '过期结果', code: '000002' }]); await new Promise(r => setImmediate(r));
    assert.equal(picker.items[0].label, '华夏成长'); picker.accept(); await done;
    assert.deepEqual(h.c.symbols, ['110020', '000001']); assert.equal(picker.disposed, true);
  } finally { h.c.dispose(); }
});
test('取消添加不改变列表，设置只读时使用持久备用值，完整代码保持可添加', async () => {
  const h = setup(); try {
    h.c.paused = true; const cancelled = h.c.add(); h.pickers[0].hide(); await cancelled; assert.deepEqual(h.c.symbols, []);
    const original = h.api.workspace.getConfiguration;
    h.api.workspace.getConfiguration = (...args) => ({ ...original(...args), update: async () => { throw new Error('只读'); } });
    await h.c.add('000001'); assert.deepEqual(h.c.symbols, ['000001']); assert.deepEqual(h.store.get('stockSettingsFallback')['funds.symbols'], ['000001']);
  } finally { h.c.dispose(); }
});
