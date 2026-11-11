const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const { AnalysisAgent, AGENT_LIMITS } = require('../dist/features/ai/agent.js');
const { completeTurn } = require('../dist/features/ai/client.js');
const { TOOLS } = require('../dist/features/ai/agent-data.js');
const { CapabilityError } = require('../dist/features/ai/protocol.js');
const { conversationContext, snapshotText, estimateTokens } = require('../dist/features/ai/agent-context.js');
const call = (id = 'c1', name = 'get_quote', args = {}) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
});
const options = () => ({
  url: 'https://example.com/v1',
  model: 'model',
  key: 'private-key',
  target: 'sh600519',
  signal: new AbortController().signal,
  messages: [
    { role: 'system', content: '根据事实回答' },
    { role: 'user', content: '现在怎样？' }
  ],
  data: { execute: async () => ({ price: 10, timestamp: '20261110103000' }) }
});
async function server(t, handle) {
  const s = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    await handle(req, res, JSON.parse(raw));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return `http://127.0.0.1:${s.address().port}/v1`;
}
const json = (res, body) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
const sse = (item) => 'data: ' + JSON.stringify(item) + '\n\n';

test('真实HTTP工具查询闭环，拆分SSE参数后按call_id回传，只有用户触发才调用', async (t) => {
  const requests = [],
    queried = [],
    deltas = [];
  const url = await server(t, async (req, res, body) => {
    requests.push(body);
    assert.equal(req.url, '/v1/chat/completions');
    if (requests.length === 1) {
      res.setHeader('Content-Type', 'text/event-stream');
      const bytes = Buffer.from(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'q1', type: 'function', function: { name: 'get_quote', arguments: '{"symbol":' } }
                ]
              }
            }
          ]
        }) +
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"sh600519"}' } }] } }] }) +
          sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      );
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      res.end();
    } else
      json(res, {
        choices: [{ message: { content: '截至10:30，价格10元。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      });
  });
  const result = await new AnalysisAgent().run({
    ...options(),
    url,
    onDelta: (x) => deltas.push(x),
    data: {
      execute: async (name, args) => {
        queried.push({ name, args });
        return { price: 10, timestamp: '20261110103000' };
      }
    }
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(queried, [{ name: 'get_quote', args: { symbol: 'sh600519' } }]);
  const tool = requests[1].messages.find((m) => m.role === 'tool');
  assert.equal(tool.tool_call_id, 'q1');
  assert.match(tool.content, /20261110103000/);
  assert.equal(result.report.queries, 1);
  assert.match(result.content, /截至10:30/);
  assert.equal(deltas.join(''), result.content);
});

test('Responses流式输出和函数查询保留加密推理关联，不携带服务端会话或存储请求', async (t) => {
  const requests = [];
  const output = [
    { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque-state' },
    { type: 'function_call', id: 'f1', call_id: 'c1', name: 'get_quote', arguments: '{}' }
  ];
  const url = await server(t, (req, res, body) => {
    requests.push(body);
    assert.equal(req.url, '/v1/responses');
    assert.equal(body.store, false);
    assert.equal(body.previous_response_id, undefined);
    res.setHeader('Content-Type', 'text/event-stream');
    if (requests.length === 1) {
      res.end(
        sse({ type: 'response.output_item.added', output_index: 1, item: { ...output[1], arguments: '' } }) +
          sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' }) +
          sse({
            type: 'response.completed',
            response: { status: 'completed', output, usage: { input_tokens: 100, output_tokens: 30 } }
          })
      );
    } else {
      assert.ok(body.input.some((m) => m.encrypted_content === 'opaque-state'));
      assert.ok(body.input.some((m) => m.type === 'function_call_output' && m.call_id === 'c1'));
      res.end(
        sse({ type: 'response.output_text.delta', delta: '完成分析' }) +
          sse({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成分析' }] }],
              usage: { input_tokens: 150, output_tokens: 40 }
            }
          })
      );
    }
  });
  const result = await new AnalysisAgent().run({ ...options(), url: url + '/responses' });
  assert.equal(result.content, '完成分析');
  assert.equal(requests.length, 2);
  assert.equal(result.report.estimated, false);
  assert.equal(result.report.inputTokens, 250);
  assert.equal(result.report.outputTokens, 70);
});

test('Chat接口明确要求Responses时自动切换同源路径，401/429和普通400绝不降级', async (t) => {
  let requests = 0,
    mode = 'responses';
  const url = await server(t, (req, res) => {
    requests++;
    if (req.url.endsWith('/responses'))
      return json(res, {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }]
      });
    res.statusCode = mode === '401' ? 401 : mode === '429' ? 429 : 400;
    json(res, {
      error: {
        message:
          mode === 'responses'
            ? 'This model requires the Responses API'
            : mode === '400'
              ? 'invalid model'
              : 'tools unsupported private-key'
      }
    });
  });
  const first = await new AnalysisAgent().run({ ...options(), url });
  assert.equal(first.content, 'ok');
  assert.equal(requests, 2);
  for (const code of ['401', '429', '400']) {
    mode = code;
    requests = 0;
    await assert.rejects(
      new AnalysisAgent().run({ ...options(), url }),
      (e) => e.message.includes(code) && !e.message.includes('private-key')
    );
    assert.equal(requests, 1);
  }
});

test('明确不支持tools才使用兼容模式，并缓存能力；失败尝试也计入本轮上限', async () => {
  const runner = new AnalysisAgent(),
    requests = [];
  const request = async (opts) => {
    requests.push(opts);
    if (opts.tools.length) throw new CapabilityError('tools');
    return { content: '使用已更新行情回答', calls: [] };
  };
  const result = await runner.run({ ...options(), request });
  assert.equal(result.report.mode, 'compatible');
  assert.equal(result.report.requests, 2);
  await runner.run({ ...options(), request });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].tools.length, 0);
});

test('重复工具并行合并，工具次数达到六次后强制最终回答而非无限循环', async () => {
  let requests = 0,
    queries = 0;
  const result = await new AnalysisAgent().run({
    ...options(),
    data: {
      execute: async () => {
        queries++;
        await new Promise((r) => setImmediate(r));
        return { value: queries };
      }
    },
    request: async (opts) => {
      requests++;
      if (requests === 1)
        return {
          content: '',
          calls: [
            call('a'),
            call('b'),
            ...Array.from({ length: 8 }, (_, i) => call('c' + i, 'get_technical', { period: String(i) }))
          ]
        };
      assert.equal(opts.tools.length, 0);
      assert.equal(opts.messages.filter((m) => m.role === 'tool').length, 10);
      return { content: '已有证据与缺失说明', calls: [] };
    }
  });
  assert.equal(queries, 6);
  assert.equal(result.report.queries, 6);
  assert.equal(requests, 2);
  assert.equal(result.report.limited, true);
});

test('连续要求补查最多三次模型请求，最后一次不再提供工具', async () => {
  let requests = 0;
  const result = await new AnalysisAgent().run({
    ...options(),
    request: async (opts) => {
      requests++;
      if (requests < 3)
        return {
          content: '',
          calls: [call('q' + requests, 'get_quote', { symbol: 'sh60051' + requests })],
          usage: { prompt_tokens: 100, completion_tokens: 30 }
        };
      assert.equal(opts.tools.length, 0);
      return { content: '最终结论', calls: [] };
    }
  });
  assert.equal(requests, 3);
  assert.equal(result.report.requests, 3);
});

test('中止补查不再调用模型，已取消的任务不会启动后续工具', async () => {
  const abort = new AbortController();
  let requests = 0;
  await assert.rejects(
    new AnalysisAgent().run({
      ...options(),
      signal: abort.signal,
      request: async () => {
        requests++;
        return { content: '', calls: [call()] };
      },
      data: {
        execute: async (_n, _a, _t, signal) => {
          abort.abort();
          assert.equal(signal.aborted, true);
          throw new Error('cancel');
        }
      }
    }),
    { name: 'AbortError' }
  );
  assert.equal(requests, 1);
});

test('没有工具完成标记的半截参数与Responses截断不执行任何查询', async (t) => {
  let responses = false;
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(
      responses
        ? sse({ type: 'response.output_text.delta', delta: '部分正文' }) + 'data: [DONE]\n\n'
        : sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...call('c', 'get_quote', {}) }] } }] }) +
            'data: [DONE]\n\n'
    );
  });
  await assert.rejects(completeTurn({ ...options(), url, tools: TOOLS }), /中断/);
  responses = true;
  await assert.rejects(completeTurn({ ...options(), url, protocol: 'responses', tools: TOOLS }), /中断/);
});

test('长历史不再重复发送旧行情包，保留近期问答与旧结论标记', () => {
  const history = [
    { role: 'user', content: '分析以下多周期行情快照：\n' + 'x'.repeat(40000) },
    ...Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 ? 'user' : 'assistant',
      content: `第${i}条` + '数据'.repeat(1000)
    }))
  ];
  const compact = conversationContext(history);
  assert.ok(compact.length <= 8);
  for (const row of history.slice(1).filter((m) => m.role === 'user'))
    assert.ok(JSON.stringify(compact).includes(row.content));
  assert.match(JSON.stringify(compact), /旧结论/);
  assert.doesNotMatch(JSON.stringify(compact), /x{100}/);
  assert.equal(history.length, 26);
  const snapshot = JSON.parse(
    snapshotText({
      target: 'sh600519',
      capturedAt: '2026-11-10',
      notes: [],
      relativeStrength: undefined,
      timeframes: { weekly: { state: '偏弱', date: '2026-11-06' } }
    })
  );
  assert.equal(snapshot.timeframes.weekly.date, '2026-11-06');
});

test('未摘要的用户原话超过预算时明确停止，不强行删掉用户约束后调用模型', async () => {
  const opts = options(),
    sizes = [];
  opts.messages.splice(1, 0, { role: 'user', content: '旧数据'.repeat(30000) });
  await assert.rejects(
    new AnalysisAgent().run({
      ...opts,
      request: async (o) => {
        sizes.push(estimateTokens({ messages: o.messages, tools: o.tools }));
        return sizes.length === 1 ? { content: '', calls: [call()] } : { content: '简短结论', calls: [] };
      }
    }),
    /保留用户原话/
  );
  assert.equal(sizes.length, 0);
});
