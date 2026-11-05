'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
const manifest = require('../package.json');
test('AI设置只写全局、校验URL与模型、不注册明文Key配置', async () => {
  const h = harness(), { SettingsController, validate } = h.load('../src/settings');
  let target;
  const original = h.api.workspace.getConfiguration;
  h.api.workspace.getConfiguration = (...args) => ({ ...original(...args), inspect: () => ({ workspaceValue: 'https://wrong.example', globalValue: 'https://example.com/v1' }), update: async (_key, _value, t) => { target = t; } });
  const c = new SettingsController(h.context); c.open('ai'); const panel = h.panels[0];
  try {
    panel.webview.receive.fire({ token: c.token, type: 'ready' }); assert.equal(panel.webview.messages.at(-1).category, 'ai');
    panel.webview.receive.fire({ token: c.token, type: 'save', key: 'ai.baseUrl', value: 'https://example.com/v1' }); await c.queue;
    assert.equal(target, h.api.ConfigurationTarget.Global); assert.equal(c.read('ai.baseUrl'), 'https://example.com/v1');
    for (const url of ['http://example.com', 'https://secret@example.com', 'https://example.com?key=123']) assert.throws(() => validate('ai.baseUrl', url));
    assert.equal(validate('ai.model', ' model-name '), 'model-name'); assert.throws(() => validate('ai.model', 'x\nkey'));
    assert.equal(Object.keys(manifest.contributes.configuration.properties).some(k => /ai\..*(key|token)/i.test(k)), false);
  } finally { c.dispose(); }
});
test('右侧视图、菜单在老板键时隐藏；侧栏行情图标保持原样', () => {
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].id, 'welove42Analysis');
  assert.equal(manifest.contributes.views.welove42Analysis[0].when, '!aShareTurnover.hidden');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'media/market.svg');
  for (const entry of Object.values(manifest.contributes.menus).flat().filter(e => e.command.includes('.ai.'))) assert.match(entry.when, /!aShareTurnover.hidden/);
});
