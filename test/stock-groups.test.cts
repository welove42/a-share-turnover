'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const A = 'sh600519',
  B = 'sz000001',
  C = 'sz300750',
  D = 'sh510300';
function setup(extra = {}) {
  const h = harness({ 'aShareTurnover.stocks.symbols': [A, B, C, D], ...extra });
  let calls = 0;
  const { WatchlistController } = h.load('../dist/features/watchlist/controller.js');
  const c = new WatchlistController(h.context, {
    provider: {
      load: async () => {
        calls++;
        return { quotes: new Map(), errors: new Map() };
      }
    }
  });
  c.paused = true;
  return { ...h, c, calls: () => calls };
}
const token = () => ({ isCancellationRequested: false });
function transfer(c, elements) {
  const value = new Map();
  c.handleDrag(elements, value, token());
  return value;
}
const members = (c, id) => c.grouping.children(id).map((s) => s.symbol);

test('旧自选默认保持原列表，创建分组后未归类股票完整保留', async () => {
  const h = setup();
  const { c } = h;
  try {
    assert.deepEqual(
      c.getChildren(c.group).map((s) => s.symbol),
      [A, B, C, D]
    );
    const id = await c.grouping.create('  观察  ');
    assert.deepEqual(
      c.getChildren(c.group).map((g) => g.id),
      [id, 'ungrouped']
    );
    assert.equal(c.grouping.bucket(id).name, '观察');
    assert.deepEqual(members(c, 'ungrouped'), [A, B, C, D]);
    assert.equal(c.getParent(c.element(A)), c.grouping.element('ungrouped'));
    assert.equal(c.getParent(c.grouping.element(id)), c.group);
    assert.equal(c.getTreeItem(c.grouping.element(id)).contextValue, 'aShareCustomGroup');
    assert.equal(c.getTreeItem(c.grouping.element('ungrouped')).contextValue, 'aShareUngrouped');
    assert.equal(h.calls(), 0);
  } finally {
    c.dispose();
  }
});

test('重命名保持节点身份，删除分组不删个股、不改变状态栏选择，重启恢复', async () => {
  const h = setup({ 'aShareTurnover.stocks.statusBarSymbol': A });
  const { c } = h;
  try {
    const id = await c.grouping.create('持仓'),
      other = await c.grouping.create('观察');
    await c.grouping.move(A, id);
    await c.grouping.move(B, other);
    const element = c.grouping.element(id),
      treeId = c.getTreeItem(element).id;
    await c.grouping.rename(id, '核心持仓');
    assert.equal(c.getTreeItem(element).id, treeId);
    assert.match(c.getTreeItem(element).label, /核心持仓 \(1\)/);
    await c.grouping.remove(id);
    assert.ok(members(c, 'ungrouped').includes(A));
    assert.equal(c.config.selected, A);
    assert.equal(c.config.symbols.length, 4);
    const { WatchlistController } = h.load('../dist/features/watchlist/controller.js'),
      restored = new WatchlistController(h.context);
    try {
      assert.deepEqual(restored.config.groups, c.config.groups);
      assert.deepEqual(members(restored, other), [B]);
    } finally {
      restored.dispose();
    }
    assert.equal(h.calls(), 0);
  } finally {
    c.dispose();
  }
});

test('跨组拖拽及组内上下排序，每只股票只出现一次；拖回 A 股标题进入未分组', async () => {
  const h = setup();
  const { c } = h;
  try {
    const g = await c.grouping.create('观察'),
      other = await c.grouping.create('持仓');
    await c.handleDrop(c.grouping.element(g), transfer(c, [c.element(A), c.element(B)]), token());
    assert.deepEqual(members(c, g), [A, B]);
    await c.handleDrop(c.element(A), transfer(c, [c.element(B)]), token());
    assert.deepEqual(members(c, g), [B, A]);
    await c.handleDrop(c.grouping.element(other), transfer(c, [c.element(C)]), token());
    await c.handleDrop(c.element(C), transfer(c, [c.element(A)]), token());
    assert.deepEqual(members(c, other), [A, C]);
    await c.handleDrop(c.group, transfer(c, [c.element(A)]), token());
    assert.equal(c.grouping.idFor(A), 'ungrouped');
    const all = c.grouping.buckets().flatMap((g) => g.symbols);
    assert.deepEqual([...all].sort(), [A, B, C, D].sort());
    assert.equal(new Set(all).size, 4);
    assert.equal(h.calls(), 0);
  } finally {
    c.dispose();
  }
});

test('分组内部按涨跌幅排序；拖动后保存当前各组显示顺序并切回手动', async () => {
  const h = setup({
    'aShareTurnover.stocks.sortBy': 'percentDesc',
    'aShareTurnover.stocks.groups': [
      { id: 'watch', name: '观察', symbols: [A, B] },
      { id: 'hold', name: '持仓', symbols: [C, D] }
    ]
  });
  const { c } = h;
  try {
    for (const [s, p] of [
      [A, 1],
      [B, 3],
      [C, 2],
      [D, 4]
    ])
      c.quotes.set(s, { percent: p });
    assert.deepEqual(members(c, 'watch'), [B, A]);
    assert.deepEqual(members(c, 'hold'), [D, C]);
    await c.handleDrop(c.element(B), transfer(c, [c.element(A)]), token());
    assert.deepEqual(members(c, 'watch'), [A, B]);
    assert.deepEqual(members(c, 'hold'), [D, C]);
    assert.equal(c.config.sortBy, 'manual');
  } finally {
    c.dispose();
  }
});

test('分组拖动只改变分组顺序，拒绝跨市场、伪造和取消的拖动', async () => {
  const h = setup({ 'aShareTurnover.stocks.hkSymbols': ['hk00700'] });
  const { c } = h;
  try {
    const a = await c.grouping.create('持仓'),
      b = await c.grouping.create('观察'),
      d = await c.grouping.create('ETF');
    await c.grouping.move(A, a);
    await c.handleDrop(c.grouping.element(a), transfer(c, [c.grouping.element(d)]), token());
    assert.deepEqual(
      c.config.groups.map((g) => g.id),
      [d, a, b]
    );
    const before = JSON.stringify(c.config),
      cancelled = token();
    cancelled.isCancellationRequested = true;
    await c.handleDrop(c.grouping.element(b), transfer(c, [c.grouping.element(d)]), cancelled);
    await c.handleDrop(c.overseas.groups.hk, transfer(c, [c.element(A)]), token());
    await c.handleDrop(c.grouping.element(a), transfer(c, [c.overseas.element('hk00700')]), token());
    assert.equal(transfer(c, [c.element(A), c.overseas.element('hk00700')]).size, 0);
    const mime = c.tree.dragAndDropController.dropMimeTypes[0];
    await c.handleDrop(c.grouping.element(b), new Map([[mime, { value: { owner: {}, symbols: [A] } }]]), token());
    assert.equal(JSON.stringify(c.config), before);
    assert.deepEqual(c.overseas.symbols.hk, ['hk00700']);
    assert.equal(c.grouping.idFor(A), a);
  } finally {
    c.dispose();
  }
});

test('分组名校验、无效配置和重复成员不会丢失或重复显示个股', async () => {
  const h = setup({
    'aShareTurnover.stocks.groups': [
      { id: 'a', name: '持仓', symbols: [A, '600519', 'hk00700', 'bad'] },
      { id: 'b', name: '观察', symbols: [A, B] },
      { id: 'bad', name: '', symbols: [C] },
      { id: 'ungrouped', name: '冒用默认组', symbols: [D] }
    ]
  });
  const { c } = h;
  try {
    assert.deepEqual(
      c.config.groups.map((g) => g.symbols),
      [[A], [B]]
    );
    assert.deepEqual(members(c, 'ungrouped'), [C, D]);
    for (const name of ['', ' ', '未分组', '持仓', 'x'.repeat(31), 'A\nB'])
      await assert.rejects(c.grouping.create(name));
    await assert.rejects(c.grouping.rename('a', '观察'));
    assert.equal(c.config.groups[0].name, '持仓');
  } finally {
    c.dispose();
  }
});

test('设置只读时分组和移动结果保存在持久存储，重启可恢复', async () => {
  const h = setup();
  const { c } = h;
  try {
    const original = h.api.workspace.getConfiguration;
    h.api.workspace.getConfiguration = (...args) => ({
      ...original(...args),
      update: async () => {
        throw new Error('只读');
      }
    });
    const id = await c.grouping.create('持仓');
    await c.grouping.move(A, id);
    await c.grouping.rename(id, '核心');
    const { WatchlistController } = h.load('../dist/features/watchlist/controller.js'),
      restored = new WatchlistController(h.context);
    try {
      assert.equal(restored.grouping.bucket(id).name, '核心');
      assert.deepEqual(members(restored, id), [A]);
    } finally {
      restored.dispose();
    }
  } finally {
    c.dispose();
  }
});

test('移除个股清理分组关系，重新添加不恢复旧分组；分组内添加只接受 A 股', async () => {
  const h = setup();
  const { c } = h;
  try {
    const id = await c.grouping.create('观察');
    await c.grouping.move(A, id);
    await c.remove(A);
    await c.add(A);
    assert.equal(c.grouping.idFor(A), 'ungrouped');
    const done = c.searchAndAdd('', 'a', id),
      picker = h.pickers.at(-1);
    assert.match(picker.title, /观察/);
    picker.change('00700');
    assert.equal(picker.items.length, 0);
    picker.change('600519');
    picker.accept();
    await done;
    assert.deepEqual(members(c, id), [A]);
    assert.equal(c.config.symbols.filter((s) => s === A).length, 1);
  } finally {
    c.dispose();
  }
});

test('搜索期间删除目标组不误加股票，隐藏时取消后续分组操作', async () => {
  const h = setup();
  const { c } = h;
  try {
    const id = await c.grouping.create('观察');
    const done = c.searchAndAdd('', 'a', id),
      picker = h.pickers.at(-1);
    picker.change('600105');
    await c.grouping.remove(id);
    picker.accept();
    await new Promise((r) => setImmediate(r));
    assert.equal(c.config.symbols.includes('sh600105'), false);
    assert.match(h.opened.at(-1).error, /分组已删除/);
    picker.hide();
    await done;
    c.setHidden(true);
    await c.grouping.create('隐藏期间');
    assert.equal(c.config.groups.length, 0);
  } finally {
    c.dispose();
  }
});

test('排队的移动使用最新成员，取消的分组拖拽不生效', async () => {
  const h = setup();
  const { c } = h;
  try {
    const a = await c.grouping.create('持仓'),
      b = await c.grouping.create('观察');
    let release;
    c.settingsQueue = new Promise((r) => {
      release = r;
    });
    const cancelled = token(),
      reorder = c.handleDrop(c.grouping.element(a), transfer(c, [c.grouping.element(b)]), cancelled);
    const move = c.grouping.move(A, b),
      add = c.add('sh600105', a);
    cancelled.isCancellationRequested = true;
    release();
    await Promise.all([reorder, move, add]);
    assert.deepEqual(
      c.config.groups.map((g) => g.id),
      [a, b]
    );
    assert.deepEqual(members(c, b), [A]);
    assert.deepEqual(members(c, a), ['sh600105']);
    assert.equal(c.config.symbols.length, 5);
  } finally {
    c.dispose();
  }
});
