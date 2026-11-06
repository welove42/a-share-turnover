'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const symbols = { hk: ['hk00700', 'hk09988', 'hk01810'], us: ['usAAPL', 'usMSFT', 'usTSLA'] };
function setup(extra = {}) {
  const h = harness({
    'aShareTurnover.stocks.symbols': ['sh600519'],
    'aShareTurnover.stocks.hkSymbols': symbols.hk,
    'aShareTurnover.stocks.usSymbols': symbols.us,
    ...extra
  });
  const { WatchlistController } = h.load('../dist/features/watchlist/controller.js');
  let calls = 0;
  const c = new WatchlistController(h.context, {
    provider: {
      load: async () => {
        calls++;
        return { quotes: new Map(), errors: new Map() };
      }
    }
  });
  c.paused = true;
  c.overseas.request = async () => {
    calls++;
    return '';
  };
  return { ...h, c, calls: () => calls };
}
const token = () => ({ isCancellationRequested: false });
function transfer(c, elements) {
  const t = new Map();
  c.handleDrag(elements, t, token());
  return t;
}
const members = (g, id) => g.children(id).map((s) => s.symbol);

for (const market of ['hk', 'us']) {
  test(`${market} 分组兼容旧自选，重命名、删除保留个股和另两市场，重启恢复`, async () => {
    const h = setup(),
      { c } = h,
      g = c.groupingFor(market),
      root = c.overseas.groups[market],
      [a, b, d] = symbols[market];
    try {
      assert.deepEqual(
        c.getChildren(root).map((e) => e.symbol),
        symbols[market]
      );
      const id = await g.create('持仓'),
        watch = await g.create('观察');
      assert.deepEqual(
        c.getChildren(root).map((e) => e.id),
        [id, watch, 'ungrouped']
      );
      assert.deepEqual(members(g, 'ungrouped'), symbols[market]);
      await g.move(a, id);
      await g.move(b, watch);
      const node = g.element(id),
        treeId = c.getTreeItem(node).id;
      await g.rename(id, '长期持仓');
      assert.equal(c.getTreeItem(node).id, treeId);
      assert.match(c.getTreeItem(node).label, /长期持仓 \(1\)/);
      assert.equal(c.getParent(node), root);
      assert.equal(c.getParent(c.overseas.element(a)), node);
      assert.equal(c.getTreeItem(node).contextValue, 'aShareCustomGroup');
      await g.remove(id);
      assert.deepEqual(members(g, 'ungrouped').sort(), [a, d].sort());
      assert.deepEqual(c.config.symbols, ['sh600519']);
      assert.deepEqual(c.groupingFor(market === 'hk' ? 'us' : 'hk').groups, []);
      const { WatchlistController } = h.load('../dist/features/watchlist/controller.js'),
        restored = new WatchlistController(h.context);
      try {
        assert.deepEqual(restored.groupingFor(market).groups, g.groups);
        assert.deepEqual(members(restored.groupingFor(market), watch), [b]);
      } finally {
        restored.dispose();
      }
      assert.equal(h.calls(), 0);
    } finally {
      c.dispose();
    }
  });

  test(`${market} 多股跨组拖拽、组内排序和分组排序，自动排序切回手动且不打断行情`, async () => {
    const h = setup(),
      { c } = h,
      g = c.groupingFor(market),
      [a, b, d] = symbols[market];
    try {
      const hold = await g.create('持仓'),
        watch = await g.create('观察');
      const drag = async (from, to) => c.handleDrop(to, transfer(c, from), token());
      await drag(
        [a, b].map((s) => c.overseas.element(s)),
        g.element(hold)
      );
      assert.deepEqual(members(g, hold), [a, b]);
      await c.updateSetting('stocks.sortBy', 'percentDesc');
      for (const [s, percent] of [
        [a, 1],
        [b, 3],
        [d, 2]
      ])
        c.overseas.quotes.set(s, { percent });
      assert.deepEqual(members(g, hold), [b, a]);
      c.paused = false;
      const abort = (c.overseas.abort[market] = new AbortController()),
        generation = c.overseas.generation;
      await drag([c.overseas.element(a)], c.overseas.element(b));
      assert.equal(c.config.sortBy, 'manual');
      assert.deepEqual(members(g, hold), [a, b]);
      await drag([c.overseas.element(b)], g.element(watch));
      await drag([c.overseas.element(d)], c.overseas.element(b));
      assert.deepEqual(members(g, watch), [d, b]);
      await drag([g.element(watch)], g.element(hold));
      assert.deepEqual(
        g.groups.map((x) => x.id),
        [watch, hold]
      );
      await drag([c.overseas.element(a)], c.overseas.groups[market]);
      assert.equal(g.idFor(a), 'ungrouped');
      assert.equal(c.overseas.generation, generation);
      assert.equal(abort.signal.aborted, false);
      assert.equal(h.calls(), 0);
      assert.equal(new Set(g.buckets().flatMap((x) => x.symbols)).size, 3);
    } finally {
      c.dispose();
    }
  });

  test(`${market} 分组搜索按市场添加；删除再添加不恢复旧组，搜索期间删除分组不误添加`, async () => {
    const h = setup(),
      { c } = h,
      g = c.groupingFor(market),
      [a] = symbols[market];
    try {
      const id = await g.create('观察'),
        add = g.add(id),
        picker = h.pickers.at(-1);
      assert.match(picker.title, market === 'hk' ? /港股到「观察」/ : /美股到「观察」/);
      picker.change(a);
      picker.accept();
      await add;
      assert.deepEqual(members(g, id), [a]);
      assert.equal(c.overseas.symbols[market].length, 3);
      await c.overseas.remove(c.overseas.element(a));
      await c.overseas.mutate(market, (list) => [...list, a]);
      assert.equal(g.idFor(a), 'ungrouped');
      const pending = g.add(id),
        p = h.pickers.at(-1);
      p.change(market === 'hk' ? '00388' : 'NVDA');
      await g.remove(id);
      p.accept();
      await c.settingsQueue;
      await Promise.resolve();
      assert.equal(c.overseas.symbols[market].length, 3);
      assert.match(h.opened.at(-1).error, /已删除/);
      p.hide();
      await pending;
      const other = await g.create('观察'),
        search = g.add(other),
        q = h.pickers.at(-1);
      q.change(market === 'hk' ? 'usAAPL' : 'hk00700');
      // Search candidates are filtered to this market, including Chinese-name matches.
      c.overseas.request = async () => 'v_hint="hk~00700~腾讯控股~txkg~GP^us~aapl.oq~苹果~pg~GP"';
      q.change(market === 'hk' ? '腾讯' : '苹果');
      await new Promise((r) => setTimeout(r, 340));
      assert.equal(q.items.length, 1);
      assert.equal(q.items[0].symbol, market === 'hk' ? 'hk00700' : 'usAAPL');
      q.accept();
      await search;
      assert.equal(g.idFor(a), other);
    } finally {
      c.dispose();
    }
  });
}

test('同名同 ID 分组跨市场隔离；拒绝跨市场和混合拖动、过期目标及取消操作', async () => {
  const configs = Object.fromEntries(
    ['hk', 'us'].map((m) => [`aShareTurnover.stocks.${m}Groups`, [{ id: 'watch', name: '观察', symbols: [] }]])
  );
  const h = setup({ ...configs, 'aShareTurnover.stocks.groups': [{ id: 'watch', name: '观察', symbols: [] }] }),
    { c } = h;
  try {
    const a = c.grouping,
      hk = c.groupingFor('hk'),
      us = c.groupingFor('us');
    assert.equal(new Set([a, hk, us].map((g) => c.getTreeItem(g.element('watch')).id)).size, 3);
    const before = JSON.stringify([...h.values]),
      drag = transfer(c, [c.overseas.element('hk00700')]);
    for (const target of [a.element('watch'), us.element('watch'), c.group, c.overseas.groups.us])
      await c.handleDrop(target, drag, token());
    await c.handleDrop(hk.element('watch'), transfer(c, [c.element('sh600519')]), token());
    await c.handleDrop(us.element('watch'), transfer(c, [hk.element('watch')]), token());
    await c.handleDrop(hk.element('watch'), drag, { isCancellationRequested: true });
    assert.equal(transfer(c, [hk.element('watch'), us.element('watch')]).size, 0);
    assert.equal(transfer(c, [c.overseas.element('hk00700'), c.overseas.element('usAAPL')]).size, 0);
    assert.equal(JSON.stringify([...h.values]), before);
    await hk.remove('watch');
    await c.handleDrop(hk.element('watch'), drag, token());
    assert.equal(hk.idFor('hk00700'), 'ungrouped');
    c.hidden = true;
    await hk.create('隐藏');
    await c.overseas.mutate('hk', () => []);
    assert.equal(c.overseas.symbols.hk.length, 3);
    assert.equal(hk.groups.length, 0);
  } finally {
    c.dispose();
  }
});

test('港美分组过滤无效成员和重复归属，设置只读时仍持久保存', async () => {
  const h = setup({
      'aShareTurnover.stocks.hkGroups': [
        { id: 'g', name: '持仓', symbols: ['700', 'usAAPL', 'sh600519'] },
        { id: 'g2', name: '观察', symbols: ['700', '09988'] }
      ]
    }),
    { c } = h;
  try {
    assert.deepEqual(
      c.overseas.stockGroups.hk.map((g) => g.symbols),
      [['hk00700'], ['hk09988']]
    );
    const original = h.api.workspace.getConfiguration;
    h.api.workspace.getConfiguration = (...args) => ({
      ...original(...args),
      update: async () => {
        throw new Error('只读');
      }
    });
    const g = c.groupingFor('us'),
      id = await g.create('持仓');
    await g.move('usAAPL', id);
    const { WatchlistController } = h.load('../dist/features/watchlist/controller.js'),
      restored = new WatchlistController(h.context);
    try {
      assert.deepEqual(members(restored.groupingFor('us'), id), ['usAAPL']);
      assert.deepEqual(restored.overseas.stockGroups.hk, c.overseas.stockGroups.hk);
    } finally {
      restored.dispose();
    }
  } finally {
    c.dispose();
  }
});

test('港美右键命令和命令面板按市场路由，外部设置变化立即更新分组', async () => {
  const h = setup(),
    { c } = h;
  try {
    h.api.window.showInputBox = async () => '观察';
    await c.groupCommand('create', c.overseas.groups.hk);
    const hk = c.groupingFor('hk');
    assert.equal(hk.groups.length, 1);
    assert.equal(c.grouping.groups.length, 0);
    h.api.window.showQuickPick = async (items) => items.find((x) => x.market === 'us');
    await c.groupCommand('create');
    assert.equal(c.groupingFor('us').groups.length, 1);
    const pending = c.groupCommand('add', hk.element(hk.groups[0].id));
    const picker = h.pickers.at(-1);
    assert.match(picker.title, /港股/);
    picker.change('01810');
    picker.accept();
    await pending;
    assert.deepEqual(hk.groups[0].symbols, ['hk01810']);
    await h.api.workspace
      .getConfiguration('aShareTurnover')
      .update('stocks.hkGroups', [{ id: 'external', name: '外部编辑', symbols: ['00700'] }]);
    assert.deepEqual(
      c.getChildren(c.overseas.groups.hk).map((g) => g.id),
      ['external', 'ungrouped']
    );
    assert.equal(hk.idFor('hk00700'), 'external');
    assert.equal(h.calls(), 0);
  } finally {
    c.dispose();
  }
});
