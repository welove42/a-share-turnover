'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const manifest=require('../package.json');
test('副图切换入口在页面内，编辑器右上角仅保留来源、刷新和浏览器按钮',()=>{
  const commands=manifest.contributes.menus['editor/title'].filter(item=>item.when.includes('stockChart')).map(item=>item.command);
  assert.deepEqual(commands,['welove42.aShareTurnover.chart.selectMode','welove42.aShareTurnover.chart.refresh','welove42.aShareTurnover.chart.openInBrowser']);
});
test('新版命令和视图使用发布者专属ID，避免旧版local-market-tools抢占；用户设置保持兼容',()=>{
  const commands=manifest.contributes.commands.map(c=>c.command);
  assert.ok(commands.length>15);
  for(const command of commands)assert.ok(command.startsWith('welove42.aShareTurnover.'),command);
  const known=new Set(commands);
  for(const menu of Object.values(manifest.contributes.menus).flat())assert.ok(known.has(menu.command),menu.command);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id,'welove42Market');
  assert.equal(manifest.contributes.views.welove42Market[0].id,'welove42.aShareTurnover.watchlist');
  assert.deepEqual(manifest.contributes.views.welove42Market.map(view=>view.id),['welove42.aShareTurnover.watchlist','welove42.aShareTurnover.globalIndices','welove42.aShareTurnover.funds','welove42.aShareTurnover.commodities']);
  assert.ok(manifest.contributes.configuration.properties['aShareTurnover.stocks.symbols']);
  for(const welcome of manifest.contributes.viewsWelcome)assert.doesNotMatch(welcome.contents,/command:aShareTurnover\./);
});
