const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const tick = () => new Promise((r) => setImmediate(r));
function setup(config = {}) {
  const h = harness({
    'aShareTurnover.stocks.symbols': ['sh600105', 'sh600519'],
    'aShareTurnover.stocks.hkSymbols': ['hk00700'],
    ...config
  });
  let now = new Date('2026-11-10T10:30:00+08:00');
  h.api.window.showWarningMessage = async () => {};
  const { WatchlistController } = h.load('../dist/features/watchlist/controller.js');
  const c = new WatchlistController(h.context, { now: () => now });
  const { StockAlerts } = h.load('../dist/features/watchlist/alerts.js');
  const alerts = new StockAlerts(h.context, c, { now: () => now });
  return { h, c, alerts, advance: (ms) => (now = new Date(+now + ms)), now: () => now };
}
function quote(symbol = 'sh600105', price = 11, seconds = 0) {
  return {
    symbol,
    name: '测试股',
    price,
    priceText: price.toFixed(2),
    percent: (price / 10 - 1) * 100,
    previousClose: 10,
    limitUp: 11,
    limitDown: 9,
    high: 11,
    low: 9,
    date: '2026-11-10',
    timestamp: '202611101030' + String(seconds).padStart(2, '0')
  };
}
test('涨幅阈值/涨停同次合并为一只未读，开板更新原因，重复报价不增加数量', async () => {
  const s = setup();
  try {
    s.alerts.check([quote()], 'a');
    assert.equal(s.c.tree.badge.value, 1);
    const element = s.c.element('sh600105'),
      item = s.c.getTreeItem(element);
    assert.match(item.description, /●.*10:30.*涨停/);
    assert.ok(item.label.highlights.length);
    assert.equal(item.command.command, 'welove42.aShareTurnover.stocks.openChart');
    s.alerts.check([quote()], 'a');
    assert.equal(s.c.tree.badge.value, 1);
    s.advance(10000);
    s.alerts.check([quote('sh600105', 10.99, 10)], 'a');
    assert.match(s.c.getTreeItem(element).description, /涨停炸板/);
    assert.equal(s.c.tree.badge.value, 1);
  } finally {
    s.alerts.dispose();
    s.c.dispose();
  }
});
test('打开侧栏定位最新异动并选中，其他未读保留；已读仍显示高亮与原因', async () => {
  const s = setup();
  try {
    s.c.activity.record(quote(), 'a', '涨幅超过7%');
    s.advance(1000);
    s.c.activity.record(quote('sh600519'), 'a', '跌幅超过7%');
    assert.equal(s.c.tree.badge.value, 2);
    assert.equal(s.c.tree.reveals.length, 0);
    s.c.tree.visible = true;
    s.c.tree.visibility.fire({ visible: true });
    await tick();
    const revealed = s.c.tree.reveals[0];
    assert.equal(revealed.element.symbol, 'sh600519');
    assert.deepEqual(revealed.options, { select: true, focus: false, expand: true });
    assert.equal(s.c.tree.badge.value, 1);
    const item = s.c.getTreeItem(revealed.element);
    assert.match(item.description, /跌幅超过7%/);
    assert.doesNotMatch(item.description, /●/);
    assert.ok(item.label.highlights.length);
    s.c.tree.selectionEvents.fire({ selection: [s.c.element('sh600105')] });
    assert.equal(s.c.tree.badge, undefined);
  } finally {
    s.alerts.dispose();
    s.c.dispose();
  }
});
test('老板键隐藏角标/标记且不定位；恢复保留未读，不主动抢焦点', async () => {
  const s = setup();
  try {
    s.c.activity.record(quote(), 'a', '涨停');
    s.c.setHidden(true);
    assert.equal(s.c.tree.badge, undefined);
    s.c.tree.visible = true;
    s.c.tree.visibility.fire({ visible: true });
    await tick();
    assert.equal(s.c.tree.reveals.length, 0);
    s.c.setHidden(false);
    assert.equal(s.c.tree.badge.value, 1);
    assert.equal(s.c.tree.reveals.length, 0);
    await s.h.api.workspace.getConfiguration('aShareTurnover').update('stockAlerts.mode', 'never');
    assert.equal(s.c.tree.badge, undefined);
    assert.equal(typeof s.c.getTreeItem(s.c.element('sh600105')).label, 'string');
  } finally {
    s.alerts.dispose();
    s.c.dispose();
  }
});
test('删除自选、交易日切换会清理角标；未读记录仅本机持久化且重启可恢复', async () => {
  const s = setup();
  let other;
  try {
    s.c.activity.record(quote(), 'a', '涨停');
    await tick();
    const { StockActivity } = s.h.load('../dist/features/watchlist/activity.js');
    s.c.activity.dispose();
    other = new StockActivity(s.c);
    assert.equal(s.c.tree.badge.value, 1);
    s.c.config.symbols = [];
    other.refresh();
    assert.equal(s.c.tree.badge, undefined);
    s.c.config.symbols = ['sh600105'];
    other.record(quote(), 'a', '涨停');
    s.advance(86400000);
    other.refresh();
    assert.equal(s.c.tree.badge, undefined);
    await tick();
    assert.deepEqual(s.h.store.get('stockActivityV1'), []);
    assert.equal((s.h.context.syncedKeys || []).includes('stockActivityV1'), false);
  } finally {
    other?.dispose();
    s.alerts.dispose();
    s.c.dispose();
  }
});
test('港股涨跌阈值共享角标并定位港股行，不触发A股限价事件', async () => {
  const s = setup();
  try {
    s.alerts.check([quote('hk00700', 11)], 'hk');
    assert.equal(s.c.tree.badge.value, 1);
    const item = s.c.getTreeItem(s.c.overseas.element('hk00700'));
    assert.match(item.description, /涨幅超过7%/);
    assert.doesNotMatch(item.description, /涨停/);
    s.c.tree.visible = true;
    s.c.tree.visibility.fire({ visible: true });
    await tick();
    assert.equal(s.c.tree.reveals[0].element.kind, 'overseasStock');
    assert.equal(s.c.tree.badge, undefined);
  } finally {
    s.alerts.dispose();
    s.c.dispose();
  }
});
test('定位失败保留未读，侧栏已经打开时新事件仅标记，不自动跳动', async () => {
  const s = setup();
  try {
    s.c.tree.visible = true;
    s.c.activity.record(quote(), 'a', '涨停');
    assert.equal(s.c.tree.reveals.length, 0);
    s.c.tree.reveal = async () => {
      throw new Error('tree rebuilding');
    };
    s.c.tree.visibility.fire({ visible: true });
    await tick();
    assert.equal(s.c.tree.badge.value, 1);
  } finally {
    s.alerts.dispose();
    s.c.dispose();
  }
});
