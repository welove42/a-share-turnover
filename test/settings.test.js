'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
const manifest = require('../package.json');
function setup() {
  const h = harness(), { SettingsController, validate, GROUPS } = h.load('../src/settings');
  const c = new SettingsController(h.context); c.open(); const panel = h.panels[0];
  const token = panel.webview.html.match(/data-token="([a-f0-9]+)"/)[1];
  const send = async message => { panel.webview.receive.fire({ token, ...message }); await c.queue; };
  return { h, c, panel, send, validate, GROUPS };
}
test('设置页覆盖所有配置，复用标签，真实保存并响应外部修改', async () => {
  const { h, c, panel, send, GROUPS } = setup();
  try {
    assert.deepEqual(GROUPS.flatMap(g => g.keys).sort(), Object.keys(manifest.contributes.configuration.properties).map(k => k.replace('aShareTurnover.', '')).sort());
    c.open(); assert.equal(h.panels.length, 1); assert.equal(panel.revealCalls, 1);
    await send({ type: 'save', key: 'news.refreshIntervalSeconds', value: 60 });
    assert.equal(h.values.get('aShareTurnover.news.refreshIntervalSeconds'), 60);
    await send({ type: 'save', key: 'reminders.categories', value: ['fed', 'cpi'] });
    assert.deepEqual(h.values.get('aShareTurnover.reminders.categories'), ['fed', 'cpi']);
    await send({ type: 'reset', key: 'news.refreshIntervalSeconds' }); assert.equal(h.values.get('aShareTurnover.news.refreshIntervalSeconds'), 30);
    await h.api.workspace.getConfiguration('aShareTurnover').update('sectors.category', 'concept');
    assert.equal(panel.webview.messages.at(-1).groups[0].fields.find(f => f.key === 'sectors.category').value, 'concept');
  } finally { c.dispose(); }
});
test('无效配置、未授权命令和过期页面不能写入；老板键关闭设置页', async () => {
  const { h, c, panel, send } = setup();
  try {
    for (const [key, value] of [['news.refreshIntervalSeconds', 0], ['news.refreshIntervalSeconds', 12.5], ['risk.dropPercent', NaN], ['additionalClosedDates', ['2026-02-30']], ['stockAlerts.mode', 'invalid'], ['reminders.categories', ['invalid']], ['stocks.symbols', ['sh600519']], ['unknown', true]]) {
      await send({ type: 'save', key, value }); assert.equal(panel.webview.messages.at(-1).ok, false); assert.equal(h.values.size, 0);
    }
    await send({ type: 'save', token: 'wrong', key: 'enabled', value: false }); assert.equal(h.values.size, 0);
    await send({ type: 'action', action: 'workbench.action.terminal.new' }); assert.equal(panel.webview.messages.at(-1).ok, false);
    c.setHidden(true); assert.equal(panel.disposed, true); c.open(); assert.equal(h.panels.length, 1);
    await send({ type: 'save', key: 'enabled', value: false }); assert.equal(h.values.size, 0);
  } finally { c.dispose(); }
});
test('写入错误留在页面，不返回成功；已有工作区覆盖写入相同层级', async () => {
  const { h, c, panel, send } = setup();
  try {
    const original = h.api.workspace.getConfiguration; let target;
    h.api.ConfigurationTarget.Workspace = 2;
    h.api.workspace.getConfiguration = (...args) => ({ ...original(...args), inspect: () => ({ workspaceValue: 'concept' }), update: async (_key, _value, t) => { target = t; throw new Error('设置文件只读'); } });
    await send({ type: 'save', key: 'sectors.category', value: 'industry' });
    assert.equal(target, 2); assert.match(panel.webview.messages.at(-1).error, /只读/);
  } finally { c.dispose(); }
});
