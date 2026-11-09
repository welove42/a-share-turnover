const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const {
  DEFAULT_COMMODITY_CODES,
  DEFAULT_FUTURES_CODES,
  isFuturesCode
} = require('../dist/features/commodities/data.js');
const quote = (code, time = '13:50:00') => ({
  code,
  price: 100,
  priceText: '100',
  previousClose: code === 'LC0' || code === 'LH0' ? null : 99,
  previousSettlement: 99,
  settlement: 100,
  volume: 10,
  openInterest: 20,
  delta: 1,
  percent: (1 / 99) * 100,
  open: 99,
  high: 101,
  low: 98,
  date: '2026-10-27',
  time,
  timestamp: Date.parse(`2026-10-27T${time}+08:00`) / 1000
});

test('升级将旧商品栏期货迁到独立列表，保留已选子集、禁用、暂停和缓存', async () => {
  const h = harness({
    'aShareTurnover.commodities.symbols': ['XAU', 'nf_LH0', 'hf_NQ', 'OIL'],
    'aShareTurnover.commodities.enabled': false
  });
  h.store.set('commoditiesPaused', true);
  h.store.set('commodityQuotes', [quote('XAU'), quote('LH0'), quote('NQ')]);
  const { migrateFutures } = h.load('../dist/features/futures/migration.js');
  await migrateFutures(h.context);
  assert.deepEqual(h.values.get('aShareTurnover.commodities.symbols'), ['XAU', 'OIL']);
  assert.deepEqual(h.values.get('aShareTurnover.futures.symbols'), ['LH0', 'NQ']);
  assert.equal(h.values.get('aShareTurnover.futures.enabled'), false);
  assert.equal(h.store.get('futuresPaused'), true);
  assert.deepEqual(
    h.store.get('futuresQuotes').map((q) => q.code),
    ['LH0', 'NQ']
  );
  await h.api.workspace.getConfiguration('aShareTurnover').update('futures.symbols', []);
  await migrateFutures(h.context);
  assert.deepEqual(h.values.get('aShareTurnover.futures.symbols'), []);
});

test('已有期货配置优先，迁移去重并保留更新的缓存；新安装保留各栏目默认值', async () => {
  const h = harness({
    'aShareTurnover.commodities.symbols': ['XAU', 'NQ'],
    'aShareTurnover.futures.symbols': ['LC0', 'NQ'],
    'aShareTurnover.futures.enabled': false
  });
  h.store.set('commodityQuotes', [quote('NQ', '13:40:00')]);
  h.store.set('futuresQuotes', [quote('NQ', '13:50:00')]);
  const { migrateFutures } = h.load('../dist/features/futures/migration.js');
  await migrateFutures(h.context);
  assert.deepEqual(h.values.get('aShareTurnover.futures.symbols'), ['LC0', 'NQ']);
  assert.equal(h.values.get('aShareTurnover.futures.enabled'), false);
  assert.equal(h.store.get('futuresQuotes')[0].time, '13:50:00');
  const fresh = harness();
  await fresh.load('../dist/features/futures/migration.js').migrateFutures(fresh.context);
  assert.equal(fresh.values.size, 0);
});

test('只读设置使用持久回退；迁移中断先保住目标列表，下次重试不丢失也不重复', async () => {
  for (const interrupt of [false, true]) {
    const h = harness({ 'aShareTurnover.commodities.symbols': ['XAU', 'LC0'] });
    const config = h.api.workspace.getConfiguration;
    const update = h.context.globalState.update;
    h.api.workspace.getConfiguration = (...args) => ({
      ...config(...args),
      update: async (key, value) => {
        if (!interrupt || key === 'commodities.symbols') throw new Error('readonly');
        return config(...args).update(key, value);
      }
    });
    if (interrupt)
      h.context.globalState.update = async (key, value) => {
        if (key === 'stockSettingsFallback') throw new Error('interrupted');
        return update(key, value);
      };
    const { migrateFutures } = h.load('../dist/features/futures/migration.js');
    await migrateFutures(h.context);
    if (interrupt) {
      assert.equal(h.store.get('futuresSeparatedV1'), undefined);
      assert.deepEqual(h.values.get('aShareTurnover.commodities.symbols'), ['XAU', 'LC0']);
      assert.deepEqual(h.values.get('aShareTurnover.futures.symbols'), ['LC0']);
      h.api.workspace.getConfiguration = config;
      h.context.globalState.update = update;
      await migrateFutures(h.context);
    }
    const { StockSettings } = h.load('../dist/features/watchlist/settings.js');
    const settings = new StockSettings(h.context);
    assert.deepEqual(settings.get('futures.symbols', []), ['LC0']);
    assert.deepEqual(settings.get('commodities.symbols', []), ['XAU']);
    assert.equal(h.store.get('futuresSeparatedV1'), true);
  }
});

test('商品和期货的列表、折叠刷新、暂停、缓存及命令互不串用', async () => {
  const h = harness(),
    calls = [];
  const options = {
    now: () => new Date('2026-10-27T13:50:01+08:00'),
    provider: {
      load: async (codes) => {
        calls.push([...codes]);
        return { quotes: new Map(codes.map((code) => [code, quote(code)])), errors: new Map() };
      }
    }
  };
  const { CommoditiesController } = h.load('../dist/features/commodities/controller.js');
  const { FuturesController } = h.load('../dist/features/futures/controller.js');
  const commodities = new CommoditiesController(h.context, options),
    futures = new FuturesController(h.context, options);
  try {
    assert.deepEqual(commodities.codes, DEFAULT_COMMODITY_CODES);
    assert.deepEqual(futures.codes, DEFAULT_FUTURES_CODES);
    commodities.tree.visible = true;
    await commodities.tick();
    await futures.tick();
    assert.deepEqual(calls, [DEFAULT_COMMODITY_CODES]);
    futures.tree.visible = true;
    await futures.tick();
    assert.deepEqual(calls[1], DEFAULT_FUTURES_CODES);
    assert.ok(h.store.get('commodityQuotes').every((q) => !isFuturesCode(q.code)));
    assert.ok(h.store.get('futuresQuotes').every((q) => isFuturesCode(q.code)));
    const item = futures.getTreeItem(futures.element('NQ'));
    assert.equal(item.contextValue, 'aShareFuture');
    assert.equal(item.command.command, 'welove42.aShareTurnover.futures.open');
    await futures.togglePause();
    assert.equal(h.store.get('futuresPaused'), true);
    assert.equal(commodities.paused, false);
    await futures.remove('LC0');
    assert.deepEqual(commodities.codes, DEFAULT_COMMODITY_CODES);
    assert.deepEqual(futures.codes, ['LH0', 'NQ']);
    futures.setHidden(true);
    assert.deepEqual(futures.getChildren(), []);
    assert.equal(futures.tree.description, undefined);
  } finally {
    commodities.dispose();
    futures.dispose();
  }
});

test('期货视图、菜单和设置入口完整注册，并受老板键约束', () => {
  const p = require('../package.json');
  const view = p.contributes.views.welove42Workspace.find((v) => v.id === 'welove42.aShareTurnover.futures');
  assert.equal(view.name, '期货');
  assert.match(view.when, /!aShareTurnover.hidden.*futures.enabled/);
  const commands = p.contributes.commands.filter((c) => c.command.includes('.futures.'));
  assert.equal(commands.length, 5);
  assert.equal(p.contributes.menus['view/title'].filter((m) => m.command.includes('.futures.')).length, 3);
  assert.equal(p.contributes.menus['view/item/context'].filter((m) => m.command.includes('.futures.')).length, 3);
  assert.deepEqual(
    p.contributes.configuration.properties['aShareTurnover.futures.symbols'].default,
    DEFAULT_FUTURES_CODES
  );
});
