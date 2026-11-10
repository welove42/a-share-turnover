const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const { HoldingsSync, HOLDINGS_SYNC_KEY, readPositions } = require('../dist/features/funds/sync.js');
const position = (shares = 100, cost = 90) => ({ shares, cost });
function device(holdings = {}, enabled = false) {
  const h = harness();
  let now = 1000;
  h.store.set('fundHoldings', holdings);
  const sync = new HoldingsSync(
    h.context.globalState,
    () => enabled,
    () => ++now
  );
  return {
    ...h,
    sync,
    enable: (value) => {
      enabled = value;
    }
  };
}
const transfer = (from, to) => to.store.set(HOLDINGS_SYNC_KEY, structuredClone(from.store.get(HOLDINGS_SYNC_KEY)));

test('同步白名单固定，密钥、会话、行情缓存、老板键和真实本机持仓不注册', async () => {
  const h = harness(),
    { DataSync, BASE_SYNC_KEYS } = h.load('../dist/core/storage/sync.js');
  const sync = new DataSync(h.context);
  const received = [];
  try {
    assert.deepEqual(h.context.syncedKeys, [...BASE_SYNC_KEYS]);
    assert.deepEqual(
      [...BASE_SYNC_KEYS].sort(),
      ['chartIndicator', 'fundHoldingsCloudV1', 'futuresCatalogV1', 'usDisplayMode'].sort()
    );
    for (const key of [
      'fundHoldings',
      'fundHoldingsRevisionsV1',
      'stockSettingsFallback',
      'ai.conversations.v1',
      'ai.apiKey',
      'bossKeyHidden',
      'stockQuotes',
      'fundQuotes',
      'fundsPaused'
    ])
      assert.ok(!h.context.syncedKeys.includes(key));
    sync.start({
      chartIndicator: () => received.push(h.store.get('chartIndicator')),
      fundHoldings: () => received.push('holdings')
    });
    await sync.reconcile();
    received.length = 0;
    h.store.set('chartIndicator', 'rsi');
    await sync.reconcile();
    await sync.reconcile();
    assert.deepEqual(received, ['rsi']);
    await h.api.workspace.getConfiguration('aShareTurnover').update('sync.fundHoldings', true);
    await sync.reconcile();
    assert.equal(received.at(-1), 'holdings');
    assert.deepEqual(h.context.syncedKeys, [...BASE_SYNC_KEYS]);
    sync.dispose();
    h.store.set('chartIndicator', 'kdj');
    await sync.reconcile();
    assert.equal(received.at(-1), 'holdings');
  } finally {
    sync.dispose();
  }
  const config = require('../package.json').contributes.configuration.properties['aShareTurnover.sync.fundHoldings'];
  assert.equal(config.default, false);
  assert.equal(config.scope, 'machine');
});

test('不开启时不上传或应用持仓；开启合并，关闭保留本机并停止发布新修改', async () => {
  const a = device({ '110020': position() }, true),
    b = device({ '000001': position(200, 180) });
  await a.sync.reconcile();
  transfer(a, b);
  const oldCloud = structuredClone(b.store.get(HOLDINGS_SYNC_KEY));
  await b.sync.reconcile();
  assert.deepEqual(b.store.get('fundHoldings'), { '000001': position(200, 180) });
  assert.deepEqual(b.store.get(HOLDINGS_SYNC_KEY), oldCloud);
  b.enable(true);
  await b.sync.reconcile();
  assert.deepEqual(Object.keys(b.store.get('fundHoldings')).sort(), ['000001', '110020']);
  transfer(b, a);
  await a.sync.reconcile();
  assert.deepEqual(a.store.get('fundHoldings'), b.store.get('fundHoldings'));
  b.enable(false);
  const cloud = structuredClone(b.store.get(HOLDINGS_SYNC_KEY));
  b.store.set('fundHoldings', { '000001': position(300, 250) });
  await b.sync.reconcile();
  assert.deepEqual(b.store.get(HOLDINGS_SYNC_KEY), cloud);
  assert.deepEqual(b.store.get('fundHoldings'), { '000001': position(300, 250) });
  const c = device({ '110020': position() });
  await c.sync.reconcile();
  assert.equal(c.store.has(HOLDINGS_SYNC_KEY), false);
});

test('持仓首次启用相同基金优先云端；不同基金修改合并，删除不会被旧设备复活', async () => {
  const a = device({ '110020': position() }, true),
    b = device({ '110020': position(999, 888) });
  await a.sync.reconcile();
  transfer(a, b);
  await b.sync.reconcile();
  b.enable(true);
  await b.sync.reconcile();
  assert.deepEqual(b.store.get('fundHoldings'), a.store.get('fundHoldings'));
  a.store.set('fundHoldings', { ...a.store.get('fundHoldings'), '000001': position(50, 40) });
  await a.sync.reconcile();
  b.store.set('fundHoldings', { ...b.store.get('fundHoldings'), '000002': position(60, 50) });
  await b.sync.reconcile();
  transfer(a, b);
  await b.sync.reconcile();
  transfer(b, a);
  await a.sync.reconcile();
  assert.deepEqual(a.store.get('fundHoldings'), b.store.get('fundHoldings'));
  assert.equal(Object.keys(a.store.get('fundHoldings')).length, 3);
  const beforeDelete = structuredClone(b.store.get(HOLDINGS_SYNC_KEY));
  const next = { ...a.store.get('fundHoldings') };
  delete next['110020'];
  a.store.set('fundHoldings', next);
  await a.sync.reconcile();
  transfer(a, b);
  await b.sync.reconcile();
  b.store.set(HOLDINGS_SYNC_KEY, beforeDelete);
  await b.sync.reconcile();
  assert.equal(b.store.get('fundHoldings')['110020'], undefined);
  assert.equal(b.store.get(HOLDINGS_SYNC_KEY).records['110020'].position, null);
  b.store.set(HOLDINGS_SYNC_KEY, undefined);
  await b.sync.reconcile();
  assert.deepEqual(a.store.get('fundHoldings'), b.store.get('fundHoldings'));
});

test('持仓同步无变化不反复写入，字段校验且不会向云端夹带额外数据', async () => {
  const a = device({ '110020': { ...position(), apiKey: 'must-not-copy' }, evil: position() }, true);
  await a.sync.reconcile();
  let writes = 0;
  const update = a.context.globalState.update;
  a.context.globalState.update = async (...args) => {
    writes++;
    return update(...args);
  };
  await a.sync.reconcile();
  await a.sync.reconcile();
  assert.equal(writes, 0);
  assert.doesNotMatch(JSON.stringify(a.store.get(HOLDINGS_SYNC_KEY)), /apiKey|must-not-copy|evil/);
  a.store.set(HOLDINGS_SYNC_KEY, {
    version: 1,
    records: {
      '000001': { at: -1, id: 'bad', position: position() },
      '000002': { at: 1, id: 'bad', position: { shares: -1, cost: 5 } }
    }
  });
  await a.sync.reconcile();
  assert.deepEqual(Object.keys(readPositions(a.store.get('fundHoldings'))), ['110020']);
});

test('期货配置和品种信息无论先后到达，都恢复相同列表，不把旧默认值写回配置', async () => {
  for (const metadataFirst of [false, true]) {
    const h = harness({ 'aShareTurnover.futures.symbols': [] });
    const { FuturesController } = h.load('../dist/features/futures/controller.js');
    const c = new FuturesController(h.context);
    const entry = { code: 'LC2703', name: '碳酸锂2703', aliases: '', unit: '元/吨', market: 'domesticFutures' };
    try {
      if (metadataFirst) h.store.set('futuresCatalogV1', [entry]);
      await h.api.workspace.getConfiguration('aShareTurnover').update('futures.symbols', ['LC2703']);
      if (!metadataFirst) {
        assert.ok(c.configError);
        h.store.set('futuresCatalogV1', [entry]);
      }
      c.restoreSyncedCatalog();
      assert.deepEqual(c.codes, ['LC2703']);
      assert.equal(c.configError, '');
      assert.match(c.getTreeItem(c.element('LC2703')).label, /碳酸锂2703/);
      assert.deepEqual(h.values.get('aShareTurnover.futures.symbols'), ['LC2703']);
      await h.api.workspace.getConfiguration('aShareTurnover').update('futures.symbols', []);
      c.restoreSyncedCatalog();
      assert.deepEqual(c.codes, []);
    } finally {
      c.dispose();
    }
  }
});

test('图表副图同步只更新当前页面，不请求行情或把接收值再次写回', () => {
  const h = harness(),
    { ChartController } = h.load('../dist/features/charts/controller.js');
  const c = new ChartController(h.context);
  const sent = [];
  try {
    c.panels.set('sh600000', { ready: true, mode: 'daily' });
    c.send = (_state, message) => sent.push(message);
    h.context.globalState.update = () => assert.fail('接收偏好不回写');
    h.store.set('chartIndicator', 'rsi');
    c.restoreSyncedPreferences();
    c.restoreSyncedPreferences();
    assert.equal(c.indicator, 'rsi');
    assert.equal(sent.length, 1);
    c.hidden = true;
    h.store.set('chartIndicator', 'kdj');
    c.restoreSyncedPreferences();
    assert.equal(c.indicator, 'kdj');
    assert.equal(sent.length, 1);
    c.panels.clear();
  } finally {
    c.dispose();
  }
});

test('同步入口交给原生面板判断状态，不因turnOn已注册就强制首次登录；不支持时明确反馈', async () => {
  const h = harness(),
    calls = [];
  h.api.commands = {
    getCommands: async () => [
      'workbench.action.quickOpen',
      'workbench.userDataSync.actions.showSyncedData',
      'workbench.userDataSync.actions.turnOn',
      'workbench.userDataSync.actions.manage'
    ],
    executeCommand: async (...args) => {
      assert.notEqual(args[0], 'workbench.userDataSync.actions.turnOn');
      calls.push(args);
    }
  };
  const { openNativeSync } = h.load('../dist/core/storage/sync.js');
  await openNativeSync('manage');
  await openNativeSync('showData');
  assert.deepEqual(calls, [
    ['workbench.action.quickOpen', '>Settings Sync: '],
    ['workbench.userDataSync.actions.showSyncedData']
  ]);
  h.api.commands.getCommands = async () => [
    'workbench.userDataSync.actions.showSyncedData',
    'workbench.userDataSync.actions.turnOn'
  ];
  await assert.rejects(openNativeSync('manage'), /无法打开同步操作列表/);
  assert.equal(calls.length, 2, '无命令面板时也不退回强制首次登录');
  h.api.commands.getCommands = async () => [];
  await assert.rejects(openNativeSync('manage'), /未提供原生设置同步/);
});

test('基金列表自动应用云端持仓，随后编辑其他基金不会覆盖刚收到的持仓', async () => {
  const remote = device({ '110020': position(400, 360) }, true);
  await remote.sync.reconcile();
  const h = harness({ 'aShareTurnover.funds.symbols': ['110020', '000001'], 'aShareTurnover.sync.fundHoldings': true });
  h.store.set(HOLDINGS_SYNC_KEY, remote.store.get(HOLDINGS_SYNC_KEY));
  const { FundsController } = h.load('../dist/features/funds/controller.js');
  const c = new FundsController(h.context);
  try {
    await c.restoreSyncedHoldings();
    assert.deepEqual(c.holdings['110020'], position(400, 360));
    await c.saveHolding('000001', position(200, 170));
    assert.deepEqual(c.holdings['110020'], position(400, 360));
    assert.deepEqual(c.holdings['000001'], position(200, 170));
    const writes = structuredClone(h.store.get(HOLDINGS_SYNC_KEY));
    await h.api.workspace.getConfiguration('aShareTurnover').update('sync.fundHoldings', false);
    await c.saveHolding('000001', position(300, 250));
    assert.deepEqual(h.store.get(HOLDINGS_SYNC_KEY), writes);
  } finally {
    c.dispose();
  }
});
