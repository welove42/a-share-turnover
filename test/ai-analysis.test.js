'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
const { secretId } = require('../src/ai-client');
const { AnalysisContext } = require('../src/ai-context');
const tick = () => new Promise(resolve => setImmediate(resolve));
const configuration = { url: 'https://example.com/v1', model: 'test' };
const sample = () => ({ quote: { symbol: 'sh600519', name: '贵州茅台', price: 1500, timestamp: '20261105150000' }, capturedAt: '2026-11-05T07:00:00Z' });
async function setup(options = {}, configured = true) {
  const h = harness(); h.api.commands = { executeCommand: async () => {} };
  const { AiAnalysisController } = h.load('../src/ai-analysis');
  if (configured) h.secrets.set(secretId(configuration.url), 'never-send-to-webview');
  const requests = [], c = new AiAnalysisController(h.context, { config: () => configuration, collect: async () => sample(), request: async args => { requests.push(args); args.onDelta?.('分析结果'); return '分析结果'; }, ...options });
  const panel = h.api.window.createWebviewPanel('ai', '', 1, {}); c.resolveWebviewView(panel); await c.ready;
  return { h, c, panel, requests };
}
test('未配置不请求，配置后点击即分析；追问沿用快照，重分析才刷新', async () => {
  let collects = 0;
  const { h, c, panel, requests } = await setup({ collect: async () => { collects++; return sample(); } }, false);
  try {
    await c.open('sh600519'); assert.equal(requests.length, 0); assert.equal(collects, 0); assert.match(c.status, /设置/);
    h.secrets.set(secretId(configuration.url), 'never-send-to-webview');
    await c.analyze(); assert.equal(requests.length, 1); assert.equal(collects, 1);
    await c.analyze('有什么风险？'); assert.equal(collects, 1); assert.equal(requests[1].messages.length, 4);
    assert.equal(requests[1].messages.at(-1).content, '有什么风险？');
    await c.analyze(); assert.equal(collects, 2); assert.equal(c.history.length, 2);
    assert.doesNotMatch(JSON.stringify(panel.webview.messages), /never-send-to-webview/);
  } finally { c.dispose(); }
});
test('行情不可用不计费；重复点击不并发；切换标的阻止旧结果覆盖', async () => {
  let resolve, calls = 0;
  const { c } = await setup({ collect: async () => { if (!calls++) throw new Error('暂无可用行情'); return sample(); }, request: args => new Promise(r => { resolve = () => { args.onDelta('旧结果'); r('旧结果'); }; }) });
  try {
    await c.open('sh600519'); assert.match(c.status, /暂无/); assert.equal(c.busy, false);
    const pending = c.analyze(); await tick(); assert.equal(c.busy, true);
    await c.analyze(); assert.equal(calls, 2);
    c.clear(); c.target = 'sh510300'; resolve(); await pending;
    assert.equal(c.messages.length, 0); assert.equal(c.history.length, 0); assert.equal(c.target, 'sh510300');
  } finally { c.dispose(); }
});
test('老板键取消流和清空HTML，拒绝旧页面消息；恢复不自动请求', async () => {
  let finish, signal, requests = 0;
  const { c, panel } = await setup({ request: args => { signal = args.signal; requests++; return new Promise(resolve => { finish = () => { args.onDelta('迟到'); resolve('迟到'); }; }); } });
  try {
    const pending = c.open('market'); await tick(); assert.equal(requests, 1);
    c.setHidden(true); assert.equal(signal.aborted, true); assert.equal(panel.webview.html, '');
    panel.webview.receive.fire({ type: 'analyze', token: c.token }); finish(); await pending;
    assert.equal(c.messages.length, 0); assert.equal(c.history.length, 0);
    c.setHidden(false); assert.equal(requests, 1); assert.match(panel.webview.html, /AI 分析/);
  } finally { c.dispose(); }
});
test('更换接口不能使用旧Key，工作区无法覆盖全局AI地址', async () => {
  let config = { ...configuration };
  const { h, c, requests } = await setup({ config: () => config });
  try {
    config = { ...config, url: 'https://other.example/v1' }; await c.open('sh600519'); assert.equal(requests.length, 0);
    h.api.window.showInputBox = async () => 'replacement'; await c.setKey();
    assert.equal(h.secrets.get(secretId(config.url)), 'replacement'); assert.equal(h.values.size, 0);
    await c.clearKey(); assert.equal(h.secrets.has(secretId(config.url)), false);
    h.api.workspace.getConfiguration = () => ({ inspect: key => ({ globalValue: key.endsWith('baseUrl') ? configuration.url : configuration.model, workspaceValue: 'https://attacker.example' }) });
    const { readConfig } = h.load('../src/ai-analysis'); assert.deepEqual(readConfig(), configuration);
  } finally { c.dispose(); }
});
test('请求失败保留可重试状态，不把不完整回答带入追问', async () => {
  let fail = false;
  const { c } = await setup({ request: async args => { if (fail) { args.onDelta('不完整'); throw new Error('AI 响应中断'); } return '完成'; } });
  try {
    await c.open('sh600519'); fail = true; await c.analyze('追问');
    assert.equal(c.busy, false); assert.equal(c.history.length, 2); assert.match(c.status, /中断/);
  } finally { c.dispose(); }
});
test('行情白名单、交易量单位和技术指标正确；缓存与缺失有说明', async () => {
  const bars = Array.from({ length: 90 }, (_, i) => ({ time: `2026-${i}`, open: i + 1, high: i + 3, low: i, close: i + 2, volume: 100, secret: 'must-not-send' }));
  const context = new AnalysisContext({ stocks: { quotes: new Map([['sh600519', { ...sample().quote, holdings: 100, secret: 'must-not-send' }]]) }, market: { snapshot: { date: '2026-11-05', amount: 100, sameTime: { percent: 21, delta: 10 }, markets: [{ symbol: 'sh000002', breadth: { advancing: 100, declining: 50, unchanged: 3 }, secret: 'must-not-send' }] }, state: { cached: true }, temperatureResult: { score: 61, label: '偏热' } }, quoteProvider: { load: async () => { throw new Error('不可用'); } }, chartProvider: { load: async () => ({ bars, source: '测试行情', secret: 'must-not-send' }) } });
  const data = await context.collect('sh600519');
  assert.equal(data.quote.cached, true); assert.equal(data.daily.bars.length, 60); assert.equal(data.daily.indicators.MA5, 89); assert.equal(data.daily.volumeUnit, '手');
  assert.match(data.notes.join(''), /缓存/); assert.doesNotMatch(JSON.stringify(data), /must-not-send|holdings/);
  const market = await context.collect('market'); assert.equal(market.market.markets[0].breadth.advancing, 100); assert.equal(market.market.amountUnit, '元');
  assert.equal(market.market.sameTime.delta, 10); assert.equal(market.market.temperature.score, 61);
  await assert.rejects(context.collect('hk00700'), /当前 AI 分析支持/);
  const empty = new AnalysisContext({ quoteProvider: { load: async () => ({ quotes: new Map() }) }, chartProvider: { load: async () => { throw new Error(); } } });
  await assert.rejects(empty.collect('sh600519'), /暂无可用行情/);
});
