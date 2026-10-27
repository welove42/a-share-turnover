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
test('基金默认空列表不请求数据，完整代码添加去重并保存，行显示净值和真实日期', async () => {
  const h = setup(); try {
    await h.c.refresh(); assert.equal(h.calls(), 0); assert.deepEqual(h.c.getChildren(), []);
    await h.c.add('110020,000198,110020'); await h.c.refresh();
    assert.deepEqual(h.c.symbols, ['110020', '000198']); assert.deepEqual(h.values.get('aShareTurnover.funds.symbols'), h.c.symbols);
    const row = h.c.getTreeItem(h.c.element('110020')); assert.match(row.label, /\+0.50%.*1.5000/); assert.match(row.description, /2026-10-26/);
    assert.equal(row.iconPath.color.id, 'charts.red'); assert.equal(h.c.getChildren()[0], h.c.element('110020'));
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
