'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const { secretId } = require('../dist/features/ai/client.js');
const { AnalysisContext } = require('../dist/features/ai/context.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const configuration = { url: 'https://example.com/v1', model: 'test' };
const sample = () => ({
  quote: { symbol: 'sh600519', name: '贵州茅台', price: 1500, timestamp: '20261105150000' },
  capturedAt: '2026-11-05T07:00:00Z'
});
async function setup(options = {}, configured = true) {
  const h = harness();
  h.api.commands = { executeCommand: async () => {} };
  const { AiAnalysisController } = h.load('../dist/features/ai/controller.js');
  if (configured) h.secrets.set(secretId(configuration.url), 'never-send-to-webview');
  const requests = [],
    c = new AiAnalysisController(h.context, {
      config: () => configuration,
      collect: async () => sample(),
      request: async (args) => {
        requests.push(args);
        args.onDelta?.('分析结果');
        return '分析结果';
      },
      ...options
    });
  const panel = h.api.window.createWebviewPanel('ai', '', 1, {});
  c.resolveWebviewView(panel);
  await c.ready;
  return { h, c, panel, requests };
}
test('未配置不请求，配置后点击即分析；追问沿用快照，重分析才刷新', async () => {
  let collects = 0;
  const { h, c, panel, requests } = await setup(
    {
      collect: async () => {
        collects++;
        return sample();
      }
    },
    false
  );
  try {
    await c.open('sh600519');
    assert.equal(requests.length, 0);
    assert.equal(collects, 0);
    assert.match(c.status, /设置/);
    h.secrets.set(secretId(configuration.url), 'never-send-to-webview');
    await c.analyze();
    assert.equal(requests.length, 1);
    assert.equal(collects, 1);
    // Output guidance must reach the actual request, including follow-ups to saved conversations.
    assert.match(requests[0].messages[0].content, /## 一句话结论/);
    assert.match(requests[0].messages[0].content, /## 接下来盯什么/);
    assert.match(requests[0].messages[0].content, /必要术语当场翻译/);
    assert.doesNotMatch(requests[0].messages[0].content, /600至900/);
    await c.analyze('有什么风险？');
    assert.equal(collects, 1);
    assert.equal(requests[1].messages.length, 4);
    assert.equal(requests[1].messages.at(-1).content, '有什么风险？');
    assert.equal(requests[1].messages[0].content, requests[0].messages[0].content);
    assert.match(requests[1].messages[0].content, /追问直接回答当前问题/);
    await c.analyze();
    assert.equal(collects, 2);
    assert.equal(c.history.length, 2);
    assert.doesNotMatch(JSON.stringify(panel.webview.messages), /never-send-to-webview/);
  } finally {
    c.dispose();
  }
});
test('行情不可用不计费；重复点击不并发；切换标的阻止旧结果覆盖', async () => {
  let resolve,
    calls = 0;
  const { c } = await setup({
    collect: async () => {
      if (!calls++) throw new Error('暂无可用行情');
      return sample();
    },
    request: (args) =>
      new Promise((r) => {
        resolve = () => {
          args.onDelta('旧结果');
          r('旧结果');
        };
      })
  });
  try {
    await c.open('sh600519');
    assert.match(c.status, /暂无/);
    assert.equal(c.busy, false);
    const pending = c.analyze();
    await tick();
    assert.equal(c.busy, true);
    await c.analyze();
    assert.equal(calls, 2);
    c.clear();
    c.target = 'sh510300';
    resolve();
    await pending;
    assert.equal(c.messages.length, 0);
    assert.equal(c.history.length, 0);
    assert.equal(c.target, 'sh510300');
  } finally {
    c.dispose();
  }
});
test('老板键取消流和清空HTML，拒绝旧页面消息；恢复不自动请求', async () => {
  let finish,
    signal,
    requests = 0;
  const { c, panel } = await setup({
    request: (args) => {
      signal = args.signal;
      requests++;
      return new Promise((resolve) => {
        finish = () => {
          args.onDelta('迟到');
          resolve('迟到');
        };
      });
    }
  });
  try {
    const pending = c.open('market');
    await tick();
    assert.equal(requests, 1);
    c.setHidden(true);
    assert.equal(signal.aborted, true);
    assert.equal(panel.webview.html, '');
    panel.webview.receive.fire({ type: 'analyze', token: c.token });
    finish();
    await pending;
    assert.equal(c.messages.length, 0);
    assert.equal(c.history.length, 0);
    c.setHidden(false);
    assert.equal(requests, 1);
    assert.match(panel.webview.html, /AI 分析/);
  } finally {
    c.dispose();
  }
});
test('更换接口不能使用旧Key，工作区无法覆盖全局AI地址', async () => {
  let config = { ...configuration };
  const { h, c, requests } = await setup({ config: () => config });
  try {
    config = { ...config, url: 'https://other.example/v1' };
    await c.open('sh600519');
    assert.equal(requests.length, 0);
    await c.saveKey('replacement', config.url);
    assert.equal(h.secrets.get(secretId(config.url)), 'replacement');
    assert.equal(h.values.size, 0);
    await c.clearKey();
    assert.equal(h.secrets.has(secretId(config.url)), false);
    h.api.workspace.getConfiguration = () => ({
      inspect: (key) => ({
        globalValue: key.endsWith('baseUrl') ? configuration.url : configuration.model,
        workspaceValue: 'https://attacker.example'
      })
    });
    const { readConfig } = h.load('../dist/features/ai/controller.js');
    assert.deepEqual(readConfig(), configuration);
  } finally {
    c.dispose();
  }
});
test('请求失败保留可重试状态，不把不完整回答标为成功', async () => {
  let fail = false;
  const { c } = await setup({
    request: async (args) => {
      if (fail) {
        args.onDelta('不完整');
        throw new Error('AI 响应中断');
      }
      return '完成';
    }
  });
  try {
    await c.open('sh600519');
    fail = true;
    await c.analyze('追问');
    assert.equal(c.busy, false);
    assert.equal(c.history.length, 2);
    assert.match(c.status, /中断/);
    assert.equal(c.messages.at(-1).state, 'error');
    assert.match(c.messages.at(-1).notice, /中断/);
    assert.equal(c.progressTimer, null);
  } finally {
    c.dispose();
  }
});

test('首次分析中断后可继续追问，带原行情与明确标记的部分正文，不自动重试', async () => {
  const requests = [];
  let collects = 0;
  const { c, panel } = await setup({
    collect: async () => {
      collects++;
      return sample();
    },
    request: async (args) => {
      requests.push(args);
      if (requests.length === 1) {
        args.onDelta('已收到的分析，条件尚未');
        throw new Error('AI 回复中途停了');
      }
      return '补全后的分析';
    }
  });
  try {
    await c.open('sh600519');
    assert.equal(c.busy, false);
    assert.equal(c.history.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(c.messages.at(-1).state, 'error');
    assert.equal(c.messages.at(-1).content, '已收到的分析，条件尚未');
    assert.equal(panel.webview.messages.at(-1).canAsk, true);
    assert.equal(panel.webview.messages.at(-1).interrupted, true);
    assert.equal(c.pendingTurn, null);
    await c.analyze('继续');
    assert.equal(collects, 1);
    assert.equal(requests.length, 2);
    const sent = requests[1].messages;
    assert.equal(sent[1].content, requests[0].messages[1].content);
    assert.equal(sent[2].role, 'assistant');
    assert.match(sent[2].content, /已收到的分析.*尚未/);
    assert.match(sent[2].content, /传输中断.*不完整/);
    assert.match(sent[0].content, /补全未完成/);
    assert.equal(sent[3].content, '继续');
    assert.equal(c.messages.at(-1).state, 'complete');
    assert.equal(c.interruptedHistory, null);
    assert.equal(c.history.length, 4);
    assert.equal(panel.webview.messages.at(-1).interrupted, false);
    await c.analyze('补充风险');
    assert.equal(requests[2].messages[3].content, '继续');
  } finally {
    c.dispose();
  }
});

test('手动停止保留可追问的部分内容，迟到回复不污染下一轮', async () => {
  let callbacks, finish;
  const requests = [];
  const { c, panel } = await setup({
    request: (args) => {
      requests.push(args);
      if (requests.length > 1) return Promise.resolve('完成补全');
      callbacks = args;
      args.onDelta('停止前的正文');
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  });
  try {
    const pending = c.open('sh600519');
    await tick();
    c.stop();
    assert.equal(callbacks.signal.aborted, true);
    assert.equal(c.busy, false);
    assert.equal(c.messages.at(-1).state, 'stopped');
    assert.equal(panel.webview.messages.at(-1).canAsk, true);
    await c.analyze('继续');
    callbacks.onDelta('迟到内容');
    finish('迟到内容');
    await pending;
    assert.equal(c.messages.at(-1).content, '完成补全');
    assert.equal(c.messages.at(-1).state, 'complete');
    assert.doesNotMatch(JSON.stringify(c.history), /迟到内容/);
    assert.match(requests[1].messages[2].content, /停止前的正文/);
  } finally {
    c.dispose();
  }
});

test('首次无正文失败不能追问；恢复请求再失败仍保留上下文，轮数限制不被绕过', async () => {
  let partial = false;
  const requests = [];
  const { c, panel } = await setup({
    request: async (args) => {
      requests.push(args);
      if (partial) args.onDelta('部分分析');
      throw new Error('AI 响应中断');
    }
  });
  try {
    await c.open('sh600519');
    assert.equal(panel.webview.messages.at(-1).canAsk, false);
    await c.analyze('继续');
    assert.equal(requests.length, 1);
    partial = true;
    await c.analyze();
    const recovery = c.interruptedHistory;
    partial = false;
    await c.analyze('继续');
    assert.equal(c.interruptedHistory, recovery);
    assert.equal(panel.webview.messages.at(-1).canAsk, true);
    partial = true;
    for (let i = 0; i < 9; i++) await c.analyze('继续');
    const count = requests.length;
    await c.analyze('继续');
    assert.equal(requests.length, count);
    assert.match(c.status, /10 轮/);
  } finally {
    c.dispose();
  }
});

test('新分析和切股隔离上下文，老板键隐藏内容并在恢复时保留原对话', async () => {
  let partial = true;
  const requests = [];
  const { c, h, panel } = await setup({
    request: async (args) => {
      requests.push(args);
      if (partial) args.onDelta('旧标的正文');
      throw new Error('AI 响应中断');
    }
  });
  try {
    await c.open('sh600519');
    assert.ok(c.interruptedHistory);
    partial = false;
    await c.analyze();
    assert.equal(c.interruptedHistory, null);
    assert.equal(requests.at(-1).messages.length, 2);
    assert.equal(panel.webview.messages.at(-1).canAsk, false);
    partial = true;
    await c.analyze();
    c.clear();
    assert.equal(c.interruptedHistory, null);
    await c.analyze();
    partial = false;
    await c.open('sh510300');
    assert.equal(c.interruptedHistory, null);
    assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /旧标的正文/);
    partial = true;
    await c.analyze();
    assert.ok(c.interruptedHistory);
    await h.api.workspace.getConfiguration('aShareTurnover').update('ai.model', 'new-model');
    assert.equal(c.interruptedHistory, null);
    assert.equal(c.messages.length, 0);
    assert.equal(c.history.length, 0);
    await c.analyze();
    c.setHidden(true);
    assert.equal(c.interruptedHistory, null);
    c.setHidden(false);
    assert.equal(panel.webview.messages.at(-1).canAsk, true);
  } finally {
    c.dispose();
  }
});

test('重启后恢复正文、快照、中断上下文及草稿，不自动请求或泄露Key', async () => {
  const { c, h, panel } = await setup({
    request: async (args) => {
      args.onDelta('收到部分回复');
      throw new Error('AI 回复中断');
    }
  });
  let restored,
    calls = 0;
  try {
    await c.open('sh600519');
    const id = c.sessionId;
    panel.webview.receive.fire({
      type: 'draft',
      token: c.token,
      sessionRevision: c.sessionRevision,
      text: '继续补全风险'
    });
    await c.saveCurrent();
    c.dispose();
    await c.archive.write;
    restored = new c.constructor(h.context, {
      config: () => configuration,
      request: async (args) => {
        calls++;
        assert.match(args.messages[2].content, /收到部分回复.*\n\n.*不完整/);
        return '恢复后补全';
      }
    });
    const view = h.api.window.createWebviewPanel('restore', '', 1, {});
    restored.resolveWebviewView(view);
    await restored.ready;
    assert.equal(restored.sessionId, id);
    assert.equal(restored.target, 'sh600519');
    assert.equal(calls, 0);
    assert.equal(view.webview.messages.at(-1).draft, '继续补全风险');
    assert.equal(view.webview.messages.at(-1).canAsk, true);
    assert.deepEqual(restored.snapshot, sample());
    assert.match(restored.status, /当时行情/);
    await restored.open('sh600519');
    assert.equal(calls, 0);
    await restored.analyze('继续');
    assert.equal(calls, 1);
    assert.equal(restored.messages.at(-1).content, '恢复后补全');
    assert.doesNotMatch(JSON.stringify([...h.store.values()]), /never-send-to-webview/);
  } finally {
    restored?.dispose();
    c.dispose();
  }
});

test('切回个股恢复该股对话，重新分析另存一段，历史选择和清空真正生效', async () => {
  const { c, h, requests } = await setup();
  try {
    await c.open('sh600519');
    const first = c.sessionId;
    await c.open('sh510300');
    assert.equal(requests.length, 2);
    await c.open('sh600519');
    assert.equal(c.sessionId, first);
    assert.equal(requests.length, 2);
    await c.analyze();
    const second = c.sessionId;
    assert.notEqual(second, first);
    assert.equal(c.archive.read().sessions.length, 3);
    h.api.window.showQuickPick = async () => {
      throw new Error('历史不应使用编辑器中央的选择框');
    };
    await c.showHistory();
    assert.equal(c.historyVisible, true);
    assert.equal(c.historyItems.length, 3);
    await c.openHistory(first);
    assert.equal(c.sessionId, first);
    assert.equal(requests.length, 3);
    assert.equal(c.historyVisible, false);
    c.clear();
    await c.archive.write;
    assert.equal(c.archive.read().sessions.length, 2);
    assert.equal(
      c.archive.read().sessions.some((s) => s.id === first),
      false
    );
    await c.deleteHistory('all');
    assert.deepEqual(c.archive.read().sessions, []);
    assert.equal(c.messages.length, 0);
  } finally {
    c.dispose();
  }
});

test('流式自动保存可在异常关闭后恢复，并拒绝旧页面草稿覆盖新对话', async () => {
  let end;
  const { c, h, panel } = await setup({
    request: (args) => {
      args.onDelta('关闭前的部分');
      return new Promise((resolve) => {
        end = resolve;
      });
    }
  });
  let restored;
  try {
    const pending = c.open('sh600519');
    await tick();
    await c.saveCurrent();
    restored = new c.constructor(h.context, { config: () => configuration, request: async () => '完成' });
    await restored.ready;
    assert.equal(restored.busy, false);
    assert.equal(restored.messages.at(-1).state, 'stopped');
    assert.match(restored.messages.at(-1).notice, /窗口关闭/);
    assert.ok(restored.interruptedHistory);
    const oldRevision = c.sessionRevision;
    c.clear();
    panel.webview.receive.fire({ type: 'draft', token: c.token, sessionRevision: oldRevision, text: '旧页面草稿' });
    assert.equal(c.draft, '');
    end('迟到结果');
    await pending;
    assert.equal(c.messages.length, 0);
  } finally {
    c.dispose();
    restored?.dispose();
  }
});

test('零正文失败、停止、重试均收尾，迟到进度不覆盖新请求', async () => {
  let fail = true,
    finish,
    callbacks;
  const { c, panel } = await setup({
    request: async (args) => {
      if (fail) throw new Error('AI 接口 HTTP 400');
      callbacks = args;
      args.onProgress('reasoning');
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  });
  try {
    await c.open('sh600519');
    assert.equal(c.busy, false);
    assert.equal(c.messages.at(-1).state, 'error');
    assert.match(c.messages.at(-1).notice, /400/);
    fail = false;
    const pending = c.analyze();
    await tick();
    assert.equal(c.messages.at(-1).phase, 'reasoning');
    assert.match(c.status, /思考/);
    c.stop();
    assert.equal(c.messages.at(-1).state, 'stopped');
    assert.equal(c.progressTimer, null);
    callbacks.onProgress('answering');
    callbacks.onDelta('迟到内容');
    finish('迟到内容');
    await pending;
    assert.equal(c.messages.at(-1).content, '');
    assert.equal(c.history.length, 0);
    assert.match(c.status, /停止/);
    assert.equal(panel.webview.messages.at(-1).busy, false);
  } finally {
    c.dispose();
  }
});

test('连接测试失败更新面板状态，不残留测试中', async () => {
  const { c } = await setup({
    request: async () => {
      throw new Error('AI 接口 HTTP 401');
    }
  });
  try {
    await assert.rejects(c.testConnection(), /401/);
    assert.equal(c.busy, false);
    assert.match(c.status, /401/);
  } finally {
    c.dispose();
  }
});
test('首次请求和后续追问确实包含完整背景，配置未完成时不采集背景', async () => {
  const snapshot = {
    ...sample(),
    market: { amount: 100 },
    sectors: { industry: '测试行业' },
    globalMarkets: { quotes: [{ name: '纳指' }] },
    commodities: { quotes: [{ name: '黄金' }] },
    news: { items: [{ title: '公开快讯' }] }
  };
  let collects = 0;
  const { c, requests } = await setup({
    collect: async () => {
      collects++;
      return snapshot;
    }
  });
  try {
    await c.open('sh600519');
    const content = requests[0].messages[1].content;
    assert.deepEqual(JSON.parse(content.slice(content.indexOf('\n') + 1)), snapshot);
    await c.analyze('结合外围有什么建议？');
    assert.equal(collects, 1);
    assert.equal(requests[1].messages[1].content, content);
    assert.equal(requests[0].maxTokens, 3000);
  } finally {
    c.dispose();
  }
});
test('行情白名单、交易量单位和技术指标正确；缓存与缺失有说明', async () => {
  const bars = Array.from({ length: 90 }, (_, i) => ({
    time: `2026-${i}`,
    open: i + 1,
    high: i + 3,
    low: i,
    close: i + 2,
    volume: 100,
    secret: 'must-not-send'
  }));
  const context = new AnalysisContext({
    environment: {
      load: async () => ({
        market: {
          amount: 100,
          amountUnit: '元',
          sameTime: { delta: 10 },
          markets: [{ breadth: { advancing: 100 } }],
          temperature: { score: 61 }
        }
      })
    },
    stocks: { quotes: new Map([['sh600519', { ...sample().quote, holdings: 100, secret: 'must-not-send' }]]) },
    market: {
      snapshot: {
        date: '2026-11-05',
        amount: 100,
        sameTime: { percent: 21, delta: 10 },
        markets: [
          { symbol: 'sh000002', breadth: { advancing: 100, declining: 50, unchanged: 3 }, secret: 'must-not-send' }
        ]
      },
      state: { cached: true },
      temperatureResult: { score: 61, label: '偏热' }
    },
    quoteProvider: {
      load: async () => {
        throw new Error('不可用');
      }
    },
    chartProvider: { load: async () => ({ bars, source: '测试行情', secret: 'must-not-send' }) }
  });
  const data = await context.collect('sh600519');
  assert.equal(data.quote.cached, true);
  assert.equal(data.daily.bars.length, 60);
  assert.equal(data.daily.indicators.MA5, 89);
  assert.equal(data.daily.volumeUnit, '手');
  assert.match(data.notes.join(''), /缓存/);
  assert.doesNotMatch(JSON.stringify(data), /must-not-send|holdings/);
  const market = await context.collect('market');
  assert.equal(market.market.markets[0].breadth.advancing, 100);
  assert.equal(market.market.amountUnit, '元');
  assert.equal(market.market.sameTime.delta, 10);
  assert.equal(market.market.temperature.score, 61);
  await assert.rejects(context.collect('hk00700'), /当前 AI 分析支持/);
  const empty = new AnalysisContext({
    environment: { load: async () => ({}) },
    quoteProvider: { load: async () => ({ quotes: new Map() }) },
    chartProvider: {
      load: async () => {
        throw new Error();
      }
    }
  });
  await assert.rejects(empty.collect('sh600519'), /暂无可用行情/);
});
