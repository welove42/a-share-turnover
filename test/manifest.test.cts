'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const manifest = require('../package.json');
test('自选股右键和侧栏菜单提供清除异动入口', () => {
  const menus = manifest.contributes.menus;
  assert.ok(
    menus['view/item/context'].some(
      (m) => m.command === 'welove42.aShareTurnover.stocks.clearActivity' && m.when.includes('aShareStock')
    )
  );
  assert.ok(
    menus['view/title'].some(
      (m) => m.command === 'welove42.aShareTurnover.stocks.clearAllActivity' && m.when.includes('marketWatch')
    )
  );
});
test('副图切换入口在页面内，编辑器右上角保留来源、刷新、浏览器和AI分析按钮', () => {
  const commands = manifest.contributes.menus['editor/title']
    .filter((item) => item.when.includes('stockChart'))
    .map((item) => item.command);
  assert.deepEqual(commands, [
    'welove42.aShareTurnover.chart.selectMode',
    'welove42.aShareTurnover.chart.refresh',
    'welove42.aShareTurnover.chart.openInBrowser',
    'welove42.aShareTurnover.ai.chart'
  ]);
});
test('新版命令和视图使用发布者专属ID，避免旧版local-market-tools抢占；用户设置保持兼容', () => {
  const commands = manifest.contributes.commands.map((c) => c.command);
  assert.ok(commands.length > 15);
  for (const command of commands) assert.ok(command.startsWith('welove42.aShareTurnover.'), command);
  const known = new Set(commands);
  for (const menu of Object.values(manifest.contributes.menus).flat()) assert.ok(known.has(menu.command), menu.command);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'welove42Workspace');
  assert.equal(manifest.contributes.views.welove42Workspace[0].id, 'welove42.aShareTurnover.marketWatch');
  assert.deepEqual(
    manifest.contributes.views.welove42Workspace.map((view) => view.id),
    [
      'welove42.aShareTurnover.marketWatch',
      'welove42.aShareTurnover.globalIndices',
      'welove42.aShareTurnover.funds',
      'welove42.aShareTurnover.commodities',
      'welove42.aShareTurnover.futures',
      'welove42.aShareTurnover.debugCover'
    ]
  );
  assert.ok(manifest.contributes.configuration.properties['aShareTurnover.stocks.symbols']);
  for (const welcome of manifest.contributes.viewsWelcome)
    assert.doesNotMatch(welcome.contents, /command:aShareTurnover\./);
});
