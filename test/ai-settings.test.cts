'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const manifest = require('../package.json');
const { secretId } = require('../dist/features/ai/client.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setupAi(request = async () => '连接成功') {
  const h = harness({ 'aShareTurnover.ai.baseUrl': 'https://example.com/v1', 'aShareTurnover.ai.model': 'test' });
  const { AiAnalysisController } = h.load('../dist/features/ai/controller.js');
  const ai = new AiAnalysisController(h.context, { request });
  await ai.ready;
  const { SettingsController } = h.load('../dist/features/settings/controller.js'),
    settings = new SettingsController(h.context, { ai });
  settings.open('ai');
  const panel = h.panels[0],
    send = (message) => panel.webview.receive.fire({ token: settings.token, ...message });
  return {
    h,
    ai,
    settings,
    panel,
    send,
    close: () => {
      settings.dispose();
      ai.dispose();
    }
  };
}

test('页面保存Key进入安全存储，接口和模型批量验证，不把密钥回发页面或设置文件', async () => {
  const x = await setupAi();
  try {
    x.send({
      type: 'aiConfigure',
      id: 'save-1',
      operation: 'save',
      url: 'https://example.com/v1',
      model: 'test',
      key: 'test-secret-value'
    });
    await x.settings.aiTaskPromise;
    assert.equal(x.h.secrets.get(secretId('https://example.com/v1')), 'test-secret-value');
    assert.equal(x.ai.keyConfigured, true);
    const field = x.settings.model().find((g) => g.id === 'ai').fields[1];
    assert.equal(field.type, 'secret');
    assert.equal(field.value, undefined);
    assert.equal(field.configured, true);
    assert.doesNotMatch(JSON.stringify(x.panel.webview.messages), /test-secret-value/);
    assert.doesNotMatch(JSON.stringify([...x.h.values]), /test-secret-value/);
    x.send({
      type: 'aiConfigure',
      id: 'save-2',
      operation: 'save',
      url: 'http://external.example',
      model: 'new',
      key: 'another-secret'
    });
    await x.settings.aiTaskPromise;
    assert.equal(x.settings.read('ai.model'), 'test');
    assert.equal(x.h.secrets.size, 1);
    assert.equal(x.panel.webview.messages.filter((m) => m.type === 'aiResult').at(-1).ok, false);
    x.send({ type: 'aiConfigure', id: 'clear-1', operation: 'clear', url: 'https://example.com/v1' });
    await x.settings.aiTaskPromise;
    assert.equal(x.h.secrets.size, 0);
    assert.equal(x.ai.keyConfigured, false);
  } finally {
    x.close();
  }
});

test('测试先保存输入并传入对应Key，明确返回进度和成功；失败反馈保留', async () => {
  let called,
    fail = false;
  const x = await setupAi(async (args) => {
    called = args;
    args.onProgress('waiting');
    if (fail) throw new Error('AI 接口 HTTP 401');
    return '连接成功';
  });
  try {
    const request = {
      type: 'aiConfigure',
      operation: 'test',
      url: 'https://new.example/v1',
      model: 'new-model',
      key: 'new-secret'
    };
    x.send({ ...request, id: 'test-1' });
    await x.settings.aiTaskPromise;
    assert.equal(called.key, 'new-secret');
    assert.equal(called.url, 'https://new.example/v1/chat/completions');
    assert.equal(called.model, 'new-model');
    assert.ok(x.panel.webview.messages.some((m) => m.type === 'aiProgress' && /等待模型/.test(m.note)));
    assert.equal(x.panel.webview.messages.filter((m) => m.type === 'aiResult').at(-1).ok, true);
    fail = true;
    x.send({ ...request, id: 'test-2', key: '' });
    await x.settings.aiTaskPromise;
    const result = x.panel.webview.messages.filter((m) => m.type === 'aiResult').at(-1);
    assert.equal(result.ok, false);
    assert.equal(result.saved, true);
    assert.match(result.error, /401/);
    assert.doesNotMatch(JSON.stringify(x.panel.webview.messages), /new-secret/);
  } finally {
    x.close();
  }
});

test('取消测试不误报成功、不阻塞普通设置；关闭页面取消请求并拒绝旧消息', async () => {
  let resolve,
    signal,
    count = 0;
  const x = await setupAi((args) => {
    signal = args.signal;
    count++;
    return new Promise((r) => {
      resolve = r;
    });
  });
  try {
    const message = {
      type: 'aiConfigure',
      id: 'test-1',
      operation: 'test',
      url: 'https://example.com/v1',
      model: 'test',
      key: 'secret'
    };
    x.send(message);
    await tick();
    assert.equal(count, 1);
    x.send({ ...message, id: 'duplicate' });
    assert.equal(count, 1);
    x.send({ type: 'save', key: 'news.refreshIntervalSeconds', value: 60 });
    await x.settings.queue;
    assert.equal(x.h.values.get('aShareTurnover.news.refreshIntervalSeconds'), 60);
    x.send({ type: 'aiCancel', id: 'test-1' });
    assert.equal(signal.aborted, true);
    resolve('迟到成功');
    await x.settings.aiTaskPromise;
    const result = x.panel.webview.messages.filter((m) => m.type === 'aiResult').at(-1);
    assert.equal(result.cancelled, true);
    assert.equal(result.ok, false);
    x.send({ ...message, id: 'test-2', key: '' });
    await tick();
    x.settings.setHidden(true);
    assert.equal(signal.aborted, true);
    const before = x.panel.webview.messages.length;
    resolve('迟到成功');
    await x.settings.aiTaskPromise;
    assert.equal(x.panel.webview.messages.length, before);
    x.send({ ...message, id: 'stale', key: 'must-not-store' });
    assert.notEqual(x.h.secrets.get(secretId(message.url)), 'must-not-store');
  } finally {
    x.close();
  }
});
test('AI设置只写全局、校验URL与模型、不注册明文Key配置', async () => {
  const h = harness(),
    { SettingsController, validate } = h.load('../dist/features/settings/controller.js');
  let target;
  const original = h.api.workspace.getConfiguration;
  h.api.workspace.getConfiguration = (...args) => ({
    ...original(...args),
    inspect: () => ({ workspaceValue: 'https://wrong.example', globalValue: 'https://example.com/v1' }),
    update: async (_key, _value, t) => {
      target = t;
    }
  });
  const c = new SettingsController(h.context);
  c.open('ai');
  const panel = h.panels[0];
  try {
    panel.webview.receive.fire({ token: c.token, type: 'ready' });
    assert.equal(panel.webview.messages.at(-1).category, 'ai');
    panel.webview.receive.fire({ token: c.token, type: 'save', key: 'ai.baseUrl', value: 'https://example.com/v1' });
    await c.queue;
    assert.equal(target, h.api.ConfigurationTarget.Global);
    assert.equal(c.read('ai.baseUrl'), 'https://example.com/v1');
    for (const url of ['http://example.com', 'https://secret@example.com', 'https://example.com?key=123'])
      assert.throws(() => validate('ai.baseUrl', url));
    assert.equal(validate('ai.model', ' model-name '), 'model-name');
    assert.throws(() => validate('ai.model', 'x\nkey'));
    assert.equal(
      Object.keys(manifest.contributes.configuration.properties).some((k) => /ai\..*(key|token)/i.test(k)),
      false
    );
  } finally {
    c.dispose();
  }
});
test('右侧视图、菜单在老板键时隐藏；侧栏行情图标保持原样', () => {
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].id, 'welove42Analysis');
  assert.equal(manifest.contributes.views.welove42Analysis[0].when, '!aShareTurnover.hidden');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'media/market.svg');
  for (const entry of Object.values(manifest.contributes.menus)
    .flat()
    .filter((e) => e.command.includes('.ai.')))
    assert.match(entry.when, /!aShareTurnover.hidden/);
});
