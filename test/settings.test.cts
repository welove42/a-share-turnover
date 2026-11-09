'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const manifest = require('../package.json');
function setup(options = {}) {
  const h = harness(),
    { SettingsController, validate, GROUPS } = h.load('../dist/features/settings/controller.js');
  const c = new SettingsController(h.context, options);
  c.open();
  const panel = h.panels[0];
  const token = panel.webview.html.match(/data-token="([a-f0-9]+)"/)[1];
  const send = async (message) => {
    panel.webview.receive.fire({ token, ...message });
    await c.queue;
  };
  return { h, c, panel, send, validate, GROUPS };
}
test('设置页覆盖常用配置，复用标签，真实保存并响应外部修改', async () => {
  const { h, c, panel, send, GROUPS } = setup();
  try {
    assert.deepEqual(
      GROUPS.flatMap((g) => g.keys).sort(),
      Object.keys(manifest.contributes.configuration.properties)
        .map((k) => k.replace('aShareTurnover.', ''))
        .filter((k) => k !== 'news.enabled') // Legacy enable/disable remains available in VS Code settings.
        .sort()
    );
    c.open();
    assert.equal(h.panels.length, 1);
    assert.equal(panel.revealCalls, 1);
    await send({ type: 'save', key: 'news.refreshIntervalSeconds', value: 60 });
    assert.equal(h.values.get('aShareTurnover.news.refreshIntervalSeconds'), 60);
    await send({ type: 'save', key: 'reminders.categories', value: ['fed', 'cpi'] });
    assert.deepEqual(h.values.get('aShareTurnover.reminders.categories'), ['fed', 'cpi']);
    await send({ type: 'reset', key: 'news.refreshIntervalSeconds' });
    assert.equal(h.values.get('aShareTurnover.news.refreshIntervalSeconds'), 30);
    await h.api.workspace.getConfiguration('aShareTurnover').update('sectors.category', 'concept');
    assert.equal(
      panel.webview.messages.at(-1).groups[0].fields.find((f) => f.key === 'sectors.category').value,
      'concept'
    );
  } finally {
    c.dispose();
  }
});

test('配色设置支持三种模式与 HEX 校验，恢复默认并提供条件颜色控件', async () => {
  const { h, c, panel, send } = setup();
  try {
    const fields = c.model().find((g) => g.id === 'stocks').fields;
    assert.deepEqual(
      fields.find((f) => f.key === 'stocks.colorMode').options.map((o) => o.label),
      ['红涨绿跌', '跟随主题', '自定义']
    );
    const color = fields.find((f) => f.key === 'stocks.upColor');
    assert.equal(color.type, 'color');
    assert.equal(color.visibleWhen.value, 'custom');
    for (const value of ['neutral', 'custom', 'redUpGreenDown']) {
      await send({ type: 'save', key: 'stocks.colorMode', value });
      assert.equal(h.values.get('aShareTurnover.stocks.colorMode'), value);
    }
    await send({ type: 'save', key: 'stocks.upColor', value: ' #AABBCC ' });
    assert.equal(h.values.get('aShareTurnover.stocks.upColor'), '#aabbcc');
    for (const value of ['red', '#fff', '#12345678', '#12345g', '"><svg/>', null]) {
      await send({ type: 'save', key: 'stocks.upColor', value });
      assert.equal(panel.webview.messages.at(-1).ok, false);
      assert.equal(h.values.get('aShareTurnover.stocks.upColor'), '#aabbcc');
    }
    await send({ type: 'reset', key: 'stocks.upColor' });
    assert.equal(h.values.get('aShareTurnover.stocks.upColor'), '#f14c4c');
  } finally {
    c.dispose();
  }
});

test('设置页可切换板块涨跌榜并恢复默认，拒绝无效方向', async () => {
  const { h, c, panel, send } = setup();
  try {
    const field = c
      .model()
      .find((g) => g.id === 'market')
      .fields.find((f) => f.key === 'sectors.direction');
    assert.equal(field.value, 'gainers');
    assert.deepEqual(
      field.options.map((o) => o.label),
      ['涨幅前十', '跌幅前十']
    );
    await send({ type: 'save', key: field.key, value: 'losers' });
    assert.equal(h.values.get('aShareTurnover.sectors.direction'), 'losers');
    await send({ type: 'save', key: field.key, value: 'unknown' });
    assert.equal(panel.webview.messages.at(-1).ok, false);
    await send({ type: 'reset', key: field.key });
    assert.equal(h.values.get('aShareTurnover.sectors.direction'), 'gainers');
  } finally {
    c.dispose();
  }
});

test('大盘成交额提醒在设置页调整开关和阈值，拒绝无效值且支持恢复默认', async () => {
  const { h, c, panel, send } = setup();
  try {
    const fields = c.model().find((g) => g.id === 'risk').fields;
    assert.equal(fields.find((f) => f.key === 'turnoverAlerts.enabled').value, true);
    assert.equal(fields.find((f) => f.key === 'turnoverAlerts.percent').value, 20);
    assert.equal(fields.find((f) => f.key === 'turnoverAlerts.colorize').value, true);
    for (const [key, value] of [
      ['turnoverAlerts.enabled', false],
      ['turnoverAlerts.percent', 25.5],
      ['turnoverAlerts.colorize', false]
    ]) {
      await send({ type: 'save', key, value });
      assert.equal(h.values.get('aShareTurnover.' + key), value);
    }
    for (const value of [0, 101, '20', NaN]) {
      await send({ type: 'save', key: 'turnoverAlerts.percent', value });
      assert.equal(panel.webview.messages.at(-1).ok, false);
    }
    await send({ type: 'reset', key: 'turnoverAlerts.percent' });
    assert.equal(h.values.get('aShareTurnover.turnoverAlerts.percent'), 20);
  } finally {
    c.dispose();
  }
});
test('无效配置、未授权命令和过期页面不能写入；老板键关闭设置页', async () => {
  const { h, c, panel, send } = setup();
  try {
    for (const [key, value] of [
      ['news.refreshIntervalSeconds', 0],
      ['news.refreshIntervalSeconds', 12.5],
      ['risk.dropPercent', NaN],
      ['additionalClosedDates', ['2026-02-30']],
      ['stockAlerts.mode', 'invalid'],
      ['reminders.categories', ['invalid']],
      ['stocks.symbols', ['sh600519']],
      ['unknown', true]
    ]) {
      await send({ type: 'save', key, value });
      assert.equal(panel.webview.messages.at(-1).ok, false);
      assert.equal(h.values.size, 0);
    }
    await send({ type: 'save', token: 'wrong', key: 'enabled', value: false });
    assert.equal(h.values.size, 0);
    await send({ type: 'action', action: 'workbench.action.terminal.new' });
    assert.equal(panel.webview.messages.at(-1).ok, false);
    c.setHidden(true);
    assert.equal(panel.disposed, true);
    c.open();
    assert.equal(h.panels.length, 1);
    await send({ type: 'save', key: 'enabled', value: false });
    assert.equal(h.values.size, 0);
  } finally {
    c.dispose();
  }
});
test('新闻设置以默认开启的标题高亮替换启用开关，保存和恢复默认生效', async () => {
  const { h, c, panel, send } = setup();
  try {
    await send({ type: 'ready' });
    const news = panel.webview.messages.at(-1).groups.find((g) => g.id === 'news');
    assert.deepEqual(
      news.fields.map((f) => f.key),
      ['news.highlightTitles', 'news.refreshIntervalSeconds']
    );
    assert.deepEqual(news.actions, []);
    assert.equal(news.fields[0].label, '高亮新闻标题');
    assert.equal(news.fields[0].value, true);
    assert.match(news.fields[0].help, /关闭.*普通/);
    await send({ type: 'save', key: 'news.highlightTitles', value: false });
    assert.equal(h.values.get('aShareTurnover.news.highlightTitles'), false);
    await send({ type: 'reset', key: 'news.highlightTitles' });
    assert.equal(h.values.get('aShareTurnover.news.highlightTitles'), true);
    assert.equal(
      manifest.contributes.commands.some((c) => /news\.(source|setToken)$/.test(c.command)),
      false
    );
    await send({ type: 'action', action: 'news.setToken' });
    assert.equal(panel.webview.messages.at(-1).ok, false);
  } finally {
    c.dispose();
  }
});

test('写入错误留在页面，不返回成功；已有工作区覆盖写入相同层级', async () => {
  const { h, c, panel, send } = setup();
  try {
    const original = h.api.workspace.getConfiguration;
    let target;
    h.api.ConfigurationTarget.Workspace = 2;
    h.api.workspace.getConfiguration = (...args) => ({
      ...original(...args),
      inspect: () => ({ workspaceValue: 'concept' }),
      update: async (_key, _value, t) => {
        target = t;
        throw new Error('设置文件只读');
      }
    });
    await send({ type: 'save', key: 'sectors.category', value: 'industry' });
    assert.equal(target, 2);
    assert.match(panel.webview.messages.at(-1).error, /只读/);
  } finally {
    c.dispose();
  }
});
test('分组名单显示名称和代码，直接移除所选项目，拒绝跨组或过期项目', async () => {
  let ids = ['sh600105', 'sh600519'],
    added = 0;
  const removed = [];
  const { c, panel, send } = setup({
    lists: {
      'stocks.symbols': {
        ids: () => ids,
        name: (id) => (id === 'sh600105' ? '永鼎股份' : '贵州茅台'),
        add: () => {
          added++;
        },
        remove: (id) => {
          removed.push(id);
          ids = ids.filter((s) => s !== id);
        }
      }
    }
  });
  try {
    await send({ type: 'ready' });
    const field = panel.webview.messages
      .at(-1)
      .groups.find((g) => g.id === 'stocks')
      .fields.find((f) => f.key === 'stocks.symbols');
    assert.deepEqual(field.items, [
      { id: 'sh600105', name: '永鼎股份' },
      { id: 'sh600519', name: '贵州茅台' }
    ]);
    assert.equal(field.addLabel, '添加 A 股');
    await send({ type: 'list', key: 'stocks.symbols', operation: 'add' });
    assert.equal(added, 1);
    await send({ type: 'list', key: 'stocks.symbols', operation: 'remove', id: 'sh600105' });
    assert.deepEqual(removed, ['sh600105']);
    assert.deepEqual(ids, ['sh600519']);
    for (const id of ['sh600105', 'hk00700', '__proto__']) {
      await send({ type: 'list', key: 'stocks.symbols', operation: 'remove', id });
      assert.equal(panel.webview.messages.at(-1).ok, false);
    }
    await send({ type: 'list', key: 'stocks.hkSymbols', operation: 'remove', id: 'sh600519' });
    assert.equal(panel.webview.messages.at(-1).ok, false);
    assert.deepEqual(ids, ['sh600519']);
  } finally {
    c.dispose();
  }
});
test('报价补齐名称时更新设置名单，相同名称不会反复重绘，隐藏后忽略名单操作', async () => {
  const h = harness(),
    emitter = new h.api.EventEmitter();
  let name,
    calls = 0;
  const { c, panel, send } = setup({
    sources: [{ onDidChangeTreeData: emitter.event }],
    lists: { 'stocks.usSymbols': { ids: () => ['usAAPL'], name: () => name, add: () => calls++ } }
  });
  try {
    await send({ type: 'ready' });
    const before = panel.webview.messages.length;
    emitter.fire();
    assert.equal(panel.webview.messages.length, before);
    name = '苹果';
    emitter.fire();
    assert.equal(panel.webview.messages.length, before + 1);
    assert.equal(
      panel.webview.messages
        .at(-1)
        .groups.find((g) => g.id === 'stocks')
        .fields.find((f) => f.key === 'stocks.usSymbols').items[0].name,
      '苹果'
    );
    c.setHidden(true);
    await send({ type: 'list', key: 'stocks.usSymbols', operation: 'add' });
    assert.equal(calls, 0);
  } finally {
    c.dispose();
    emitter.dispose();
  }
});

test('设置页分组操作写入实际自选，拒绝跨市场个股、越界分组和直接覆盖分组配置', async () => {
  const h = harness({ 'aShareTurnover.stocks.symbols': ['sh600105', 'sh600519'] });
  const { WatchlistController } = h.load('../dist/features/watchlist/controller.js'),
    stocks = new WatchlistController(h.context);
  stocks.paused = true;
  const { SettingsController } = h.load('../dist/features/settings/controller.js'),
    c = new SettingsController(h.context, {
      stocks,
      sources: [stocks],
      lists: { 'stocks.symbols': { ids: () => stocks.config.symbols, name: () => '示例股票' } }
    });
  c.open();
  const panel = h.panels[0],
    token = panel.webview.html.match(/data-token="([a-f0-9]+)"/)[1];
  const send = async (m) => {
    panel.webview.receive.fire({ token, ...m });
    await c.queue;
  };
  try {
    const id = await stocks.grouping.create('观察');
    await send({ type: 'ready' });
    const fields = panel.webview.messages.at(-1).groups.find((g) => g.id === 'stocks').fields;
    assert.equal(
      fields.some((f) => f.key === 'stocks.groups'),
      false
    );
    assert.equal(fields.find((f) => f.key === 'stocks.symbols').stockGroups[0].name, '观察');
    await send({ type: 'stockGroup', key: 'stocks.symbols', operation: 'move', groupId: id, id: 'sh600105' });
    assert.deepEqual(stocks.grouping.bucket(id).symbols, ['sh600105']);
    for (const m of [
      { type: 'stockGroup', key: 'stocks.symbols', operation: 'move', groupId: id, id: 'hk00700' },
      { type: 'stockGroup', key: 'stocks.symbols', operation: 'move', groupId: 'missing', id: 'sh600105' },
      { type: 'stockGroup', key: 'stocks.symbols', operation: 'remove', groupId: 'ungrouped' },
      { type: 'stockGroup', key: 'funds.symbols', operation: 'create' },
      { type: 'save', key: 'stocks.groups', value: [] }
    ]) {
      await send(m);
      assert.equal(panel.webview.messages.at(-1).ok, false);
    }
    await send({ type: 'stockGroup', key: 'stocks.symbols', operation: 'remove', groupId: id });
    assert.equal(stocks.config.groups.length, 0);
    assert.equal(stocks.config.symbols.length, 2);
    c.setHidden(true);
    await send({ type: 'stockGroup', key: 'stocks.symbols', operation: 'create' });
    assert.equal(stocks.config.groups.length, 0);
  } finally {
    c.dispose();
    stocks.dispose();
  }
});

test('设置页独立管理港股与美股分组，不串市场，错误保留原名单', async () => {
  const h = harness({ 'aShareTurnover.stocks.hkSymbols': ['hk00700'], 'aShareTurnover.stocks.usSymbols': ['usAAPL'] });
  const { WatchlistController } = h.load('../dist/features/watchlist/controller.js'),
    stocks = new WatchlistController(h.context);
  stocks.paused = true;
  const { SettingsController } = h.load('../dist/features/settings/controller.js'),
    c = new SettingsController(h.context, { stocks, sources: [stocks] });
  c.open();
  const panel = h.panels[0],
    token = panel.webview.html.match(/data-token="([a-f0-9]+)"/)[1];
  const send = async (m) => {
    panel.webview.receive.fire({ token, ...m });
    await c.queue;
  };
  const lastResult = () => panel.webview.messages.filter((m) => m.type === 'result').at(-1);
  try {
    h.api.window.showInputBox = async () => '持仓';
    for (const [market, symbol] of [
      ['hk', 'hk00700'],
      ['us', 'usAAPL']
    ]) {
      const key = `stocks.${market}Symbols`,
        grouping = stocks.groupingFor(market);
      await send({ type: 'stockGroup', key, operation: 'create' });
      assert.equal(lastResult().ok, true);
      const groupId = grouping.groups[0].id;
      await send({ type: 'stockGroup', key, operation: 'move', id: symbol, groupId });
      assert.equal(grouping.idFor(symbol), groupId);
      h.api.window.showInputBox = async (options) => (options.value ? '长期持仓' : '持仓');
      await send({ type: 'stockGroup', key, operation: 'rename', groupId });
      assert.equal(grouping.groups[0].name, '长期持仓');
      const fields = c.model().find((g) => g.id === 'stocks').fields;
      assert.equal(
        fields.some((f) => f.key === `stocks.${market}Groups`),
        false
      );
      assert.deepEqual(fields.find((f) => f.key === key).stockGroups[0].symbols, [symbol]);
      for (const message of [
        { type: 'stockGroup', key, operation: 'move', id: market === 'hk' ? 'usAAPL' : 'hk00700', groupId },
        { type: 'stockGroup', key, operation: 'remove', groupId: 'ungrouped' },
        { type: 'save', key: `stocks.${market}Groups`, value: [] }
      ]) {
        await send(message);
        assert.equal(lastResult().ok, false);
      }
      await send({ type: 'stockGroup', key, operation: 'remove', groupId });
      assert.equal(grouping.groups.length, 0);
      assert.deepEqual(grouping.config.symbols, [symbol]);
    }
    assert.equal(stocks.grouping.groups.length, 0);
  } finally {
    c.dispose();
    stocks.dispose();
  }
});
