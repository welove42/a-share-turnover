const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeConversation, usableMemory, rollConversation } = require('../dist/features/ai/conversation-memory');
const { conversationContext } = require('../dist/features/ai/agent-context');
const { InterestStore } = require('../dist/features/ai/interests');
const { ProfileStore } = require('../dist/features/ai/profile');
const { harness } = require('./vscode-mock.cts');
const facts = () => ({
  goals: ['关注回撤'],
  constraints: ['成本50元'],
  corrections: [],
  facts: [],
  conclusions: [],
  unresolved: []
});
const options = () => ({
  url: 'https://example.com/v1',
  model: 'test',
  key: 'test',
  signal: new AbortController().signal
});
const history = () =>
  Array.from({ length: 18 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: i % 2 ? '近期数据仍需核实。'.repeat(350) : `问题${i}：我想关注风险。`
  }));
test('长对话用模型合并摘要，近期原文完整保留，已覆盖记录不重复压缩', async () => {
  const rows = history();
  let calls = 0;
  const request = async (args) => {
    calls++;
    assert.equal(args.tools.length, 0);
    assert.match(args.messages[1].content, /问题0/);
    return { content: JSON.stringify(facts()), calls: [] };
  };
  const result = await summarizeConversation(rows, undefined, options(), request);
  assert.equal(calls, 1);
  assert.ok(result.memory.covered > 0);
  const context = conversationContext(rows, result.memory);
  assert.match(context[0].content, /成本50元/);
  assert.equal(context.at(-1).content, rows.at(-1).content);
  await summarizeConversation(rows, result.memory, options(), request);
  assert.equal(calls, 1);
  assert.equal(usableMemory(result.memory, [{ role: 'user', content: '不同会话' }]), undefined);
});
test('摘要无效或取消不生成覆盖游标；原文后半段的约束保留', async () => {
  await assert.rejects(
    summarizeConversation(history(), undefined, options(), async () => ({ content: '不是摘要', calls: [] }))
  );
  const rows = [
    { role: 'user', content: '背景。'.repeat(400) + '更正：只看长期，不考虑短线。' },
    { role: 'assistant', content: '收到。' }
  ];
  assert.match(conversationContext(rows)[0].content, /更正：只看长期/);
  const base = [
    { role: 'system', content: '分析' },
    { role: 'user', content: '当前行情快照\n{}' },
    ...conversationContext(rows),
    { role: 'user', content: '现在呢' }
  ];
  assert.match(JSON.stringify(base), /更正：只看长期/);
  const control = new AbortController();
  await assert.rejects(
    summarizeConversation(history(), undefined, { ...options(), signal: control.signal }, async () => {
      control.abort();
      return { content: JSON.stringify(facts()), calls: [] };
    })
  );
});
test('关注统计去抖、按周期衰减，默认展示不计偏好；关闭与过期不使用', async () => {
  const h = harness();
  let now = Date.parse('2026-11-11T02:00:00Z'),
    enabled = true;
  const store = new InterestStore(
    h.context.globalState,
    () => enabled,
    () => now
  );
  store.record('sh600519', 'open');
  store.record('sh600519', 'open');
  assert.equal(store.summary('sh600519', [], '白酒').currentViews, 1);
  assert.equal(store.summary('sh600519', []).horizonHint, '不确定或多周期关注');
  for (let i = 0; i < 5; i++) {
    now += 60000;
    store.record('sh600519', 'period', 'monthly');
  }
  assert.equal(store.summary('sh600519', []).horizonHint, '长期背景');
  assert.equal(store.summary('sz000001', []).horizonHint, '不确定或多周期关注');
  enabled = false;
  store.record('sh600519', 'open');
  assert.equal(store.summary('sh600519', []), null);
  enabled = true;
  now += 31 * 86400000;
  assert.equal(store.summary('sh600519', []).currentViews, 0);
  await store.clear();
  assert.deepEqual(h.store.get('ai.interests.v1'), []);
});
test('画像无证据不猜风险，明确更正更新偏好，仓位独立于标的且可以清空', async () => {
  const h = harness(),
    store = new ProfileStore(h.context.globalState);
  await store.learn(undefined, { horizonHint: '短线' }, 'sh600519', options(), async () => ({
    content: JSON.stringify({ risk: { value: 'aggressive', evidence: '经常点击' } }),
    calls: []
  }));
  assert.equal(store.read().risk, 'unknown');
  await store.learn('我很保守，只看长线', '', 'sh600519', options(), async () => ({
    content: JSON.stringify({
      risk: { value: 'conservative', evidence: '我很保守' },
      horizon: { value: 'long', evidence: '只看长线' }
    }),
    calls: []
  }));
  assert.equal(store.read().risk, 'conservative');
  await store.edit(
    { risk: 'balanced', horizon: 'medium', goal: '降低回撤', holding: { status: 'held', cost: 50, exposure: 10 } },
    'sh600519'
  );
  await store.editHolding({ status: 'held', cost: 50, exposure: 10 }, 'sh600519');
  assert.equal(store.positionForAnalysis('sh600519').cost, 50);
  assert.equal(store.positionForAnalysis('sz000001'), null);
  assert.equal(new ProfileStore(h.context.globalState).read().horizon, 'medium');
  await store.clear();
  assert.equal(store.read().initialized, false);
});
test('对话提取仓位成本保留待确认标记，不采纳原话没有的数字', async () => {
  const h = harness(),
    store = new ProfileStore(h.context.globalState);
  const question = '我持仓成本50元，个股仓位占10%';
  await store.learn(question, null, 'sh600519', options(), async () => ({
    content: JSON.stringify({
      holding: { symbol: 'sh600519', status: 'held', cost: 50, exposure: 99, evidence: question }
    }),
    calls: []
  }));
  assert.equal(store.positionForAnalysis('sh600519').cost, 50);
  assert.equal(store.positionForAnalysis('sh600519').exposure, null);
  assert.equal(store.positionForAnalysis('sh600519').confirmed, false);
});

test('长聊滚动保存后保留摘要及摘要游标，无摘要不静默裁剪', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `对话${i}` }));
  const r = await summarizeConversation(rows, undefined, options(), async () => ({
    content: JSON.stringify(facts()),
    calls: []
  }));
  const rolled = rollConversation(rows, r.memory);
  assert.equal(rolled.history.length, 118);
  assert.equal(rolled.memory.covered, r.memory.covered - 2);
  assert.ok(usableMemory(rolled.memory, rolled.history));
  assert.match(JSON.stringify(conversationContext(rolled.history, rolled.memory)), /成本50元/);
  const h = harness(),
    { AiHistoryStore } = require('../dist/features/ai/history');
  const archive = new AiHistoryStore(h.context.globalState);
  await archive.save({
    id: '1234567890123456',
    target: 'sh600519',
    updatedAt: 1,
    messages: [],
    history: rolled.history,
    memory: rolled.memory
  });
  const restored = archive.read().sessions[0];
  assert.ok(usableMemory(restored.memory, restored.history));
  assert.throws(() => rollConversation(rows), /避免丢失约束/);
});

test('其他股票的成本不写入当前标的；恢复时丢弃损坏和未知字段', async () => {
  const h = harness(),
    store = new ProfileStore(h.context.globalState),
    question = '我的平安银行sz000001成本15元';
  await store.learn(question, null, 'sh600519', options(), async () => ({
    content: JSON.stringify({
      holding: { symbol: 'sz000001', status: 'held', cost: 15, exposure: null, evidence: question }
    }),
    calls: []
  }));
  assert.equal(store.positionForAnalysis('sh600519'), null);
  h.store.set('ai.profile.v1', {
    risk: 'bad',
    horizon: 'long',
    goal: 123,
    holdings: { sh600519: null, sz000001: { cost: -10 } },
    key: 'do-not-keep',
    observation: 123
  });
  const restored = new ProfileStore(h.context.globalState).read();
  assert.equal(restored.risk, 'unknown');
  assert.equal(restored.horizon, 'long');
  assert.equal(restored.holdings, undefined);
  assert.doesNotMatch(JSON.stringify(restored), /do-not-keep/);
});
test('画像清空后迟到的模型提取不能写回', async () => {
  const h = harness(),
    store = new ProfileStore(h.context.globalState);
  let resolve;
  const pending = store.learn('我偏保守', null, 'sh600519', options(), () => new Promise((r) => (resolve = r)));
  await store.clear();
  resolve({ content: JSON.stringify({ risk: { value: 'conservative', evidence: '我偏保守' } }), calls: [] });
  await pending;
  assert.equal(store.read().risk, 'unknown');
});
test('图表只有主动打开、切换周期和指标计数；同步恢复和自动刷新不计数', async () => {
  const h = harness(),
    events = [];
  const { ChartController } = h.load('../dist/features/charts/controller');
  const c = new ChartController(h.context, { onInteraction: (...args) => events.push(args) });
  try {
    await c.open('sh600519');
    const state = [...c.panels.values()][0];
    assert.deepEqual(events, [['sh600519', 'open']]);
    c.receive(state, { token: state.token, action: 'period', mode: 'weekly' });
    assert.equal(events.length, 1);
    state.ready = true;
    c.receive(state, { token: state.token, action: 'period', mode: 'weekly' });
    c.selectIndicator(state, 'rsi');
    assert.equal(events.length, 3);
    c.restoreSyncedPreferences();
    assert.equal(events.length, 3);
    c.hidden = true;
    c.changeMode(state, 'monthly');
    c.selectIndicator(state, 'kdj');
    assert.equal(events.length, 3);
  } finally {
    c.dispose();
  }
});
