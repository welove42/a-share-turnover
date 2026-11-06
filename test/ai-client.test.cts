'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const { endpoint, secretId, complete, requestBody, diagnosticText } = require('../dist/features/ai/client.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function server(t, handle) {
  const s = http.createServer(handle);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return `http://127.0.0.1:${s.address().port}/v1`;
}
const args = (url) => ({
  url,
  model: 'test-model',
  key: 'secret-test-key',
  messages: [{ role: 'user', content: '测试' }]
});
test('API路径规范化，密钥绑定完整接口，拒绝外部HTTP和地址内凭据', () => {
  assert.equal(endpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.equal(endpoint('https://example.com/chat/completions'), 'https://example.com/chat/completions');
  assert.equal(secretId('https://example.com/v1/'), secretId('https://example.com/v1/chat/completions'));
  assert.notEqual(secretId('https://example.com/a'), secretId('https://example.com/b'));
  for (const url of [
    'http://example.com',
    'https://key@example.com',
    'https://example.com?api_key=key',
    'https://example.com/#hash',
    'file:///tmp'
  ])
    assert.throws(() => endpoint(url));
});
test('SSE处理拆分的UTF8、CRLF、心跳和结束标记，按Chat Completions协议发送', async (t) => {
  let request;
  const url = await server(t, async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    request = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const raw = Buffer.from(
      ': ping\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"中文分析"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    );
    for (let i = 0; i < raw.length; i += 3) {
      res.write(raw.subarray(i, i + 3));
      await delay(1);
    }
    res.end();
  });
  let streamed = '';
  assert.equal(
    await complete({
      ...args(url),
      onDelta: (s) => {
        streamed += s;
      }
    }),
    '中文分析'
  );
  assert.equal(streamed, '中文分析');
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.auth, 'Bearer secret-test-key');
  assert.equal(request.body.stream, true);
  assert.equal(request.body.model, 'test-model');
});
test('兼容忽略stream的JSON接口，空内容和截断流不能算成功', async (t) => {
  let mode = 'json';
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', mode === 'json' ? 'application/json' : 'text/event-stream');
    res.end(
      mode === 'json'
        ? JSON.stringify({ choices: [{ message: { content: '正常回复' } }] })
        : mode === 'empty'
          ? 'data: [DONE]\n\n'
          : 'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'
    );
  });
  assert.equal(await complete(args(url)), '正常回复');
  mode = 'empty';
  await assert.rejects(complete(args(url)), /未返回/);
  mode = 'cut';
  await assert.rejects(complete(args(url)), /中断/);
});
test('错误信息不回显服务商内容，重定向不转发Key', async (t) => {
  let status = 401,
    redirected = 0;
  const url = await server(t, (req, res) => {
    if (req.url === '/stolen') redirected++;
    res.writeHead(status, { Location: '/stolen' });
    res.end('secret-test-key and private provider response');
  });
  for (const code of [401, 403, 404, 429, 500, 302]) {
    status = code;
    await assert.rejects(
      complete(args(url)),
      (error) => error.message.includes(String(code)) && !error.message.includes('secret-test-key')
    );
  }
  assert.equal(redirected, 0);
});
test('取消、超时和超长输出均中止请求', async (t) => {
  let mode = 'slow';
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': ready\n\n');
    if (mode === 'large')
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(64001) } }] }) + '\n\n');
  });
  const abort = new AbortController(),
    promise = complete({ ...args(url), signal: abort.signal });
  abort.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  await assert.rejects(complete({ ...args(url), timeoutMs: 30 }), /超时/);
  mode = 'large';
  await assert.rejects(complete(args(url)), /过长/);
});
test('长度截断和流内错误不伪装成分析完成', async (t) => {
  let error = false;
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(
      'data: ' +
        JSON.stringify(
          error
            ? { error: { message: 'secret-test-key' } }
            : { choices: [{ delta: { content: '截断内容' }, finish_reason: 'length' }] }
        ) +
        '\n\ndata: [DONE]\n\n'
    );
  });
  await assert.rejects(complete(args(url)), /长度上限/);
  error = true;
  await assert.rejects(
    complete(args(url)),
    (e) => /服务返回错误/.test(e.message) && !e.message.includes('secret-test-key')
  );
});

test('OpenAI使用现代输出上限并预留推理额度，其他兼容接口保留原参数', () => {
  const messages = [{ role: 'user', content: '测试' }];
  const body = requestBody('https://api.openai.com/v1/chat/completions', 'gpt-6.1-terra', messages, 3000);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.max_completion_tokens, 7096);
  assert.equal(body.messages, messages);
  assert.equal(
    requestBody('https://api.openai.com/v1/chat/completions', 'gpt-4o', messages, 3000).max_completion_tokens,
    3000
  );
  assert.equal(
    requestBody('https://api.openai.com/v1/chat/completions', 'gpt-6.1-terra', messages, 64).max_completion_tokens,
    1088
  );
  assert.equal(
    requestBody('https://compatible.example/v1/chat/completions', 'gpt-6.1-terra', messages, 3000).max_tokens,
    3000
  );
});

test('推理阶段只上报状态，不泄露或混入正文；完成信号后无需等连接关闭', async (t) => {
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"分析结果"},"finish_reason":"stop"}]}\n\n');
    // Deliberately leave the connection open, without [DONE].
  });
  const progress = [],
    chunks = [];
  assert.equal(
    await complete({
      ...args(url),
      timeoutMs: 1000,
      onProgress: (p) => progress.push(p),
      onDelta: (p) => chunks.push(p)
    }),
    '分析结果'
  );
  assert.deepEqual(progress, ['connecting', 'waiting', 'reasoning', 'answering']);
  assert.deepEqual(chunks, ['分析结果']);
});

test('网关漏写SSE类型仍能逐段接收，推理无正文与错误协议给出明确原因', async (t) => {
  let mode = 'sse';
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'sse') res.end('data: {"choices":[{"delta":{"content":"兼容流"},"finish_reason":"stop"}]}\n\n');
    if (mode === 'reasoning')
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: 'private reasoning' }, finish_reason: 'stop' }]
        })
      );
    if (mode === 'limit')
      res.end(JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }] }));
    if (mode === 'responses') res.write('data: {"type":"response.created"}\n\n');
  });
  assert.equal(await complete(args(url)), '兼容流');
  mode = 'reasoning';
  await assert.rejects(complete(args(url)), /只返回了推理过程/);
  mode = 'limit';
  await assert.rejects(complete(args(url)), /尚未返回正文/);
  mode = 'responses';
  await assert.rejects(complete(args(url)), /Responses 格式/);
});

test('心跳不能无限延长等待，有效推理重置空闲计时但仍受总时限约束', async (t) => {
  let mode = 'heartbeat';
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(': ready\n\n');
    const timer = setInterval(
      () =>
        res.write(mode === 'heartbeat' ? ': ping\n\n' : 'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n'),
      10
    );
    res.on('close', () => clearInterval(timer));
  });
  await assert.rejects(complete({ ...args(url), idleTimeoutMs: 70, timeoutMs: 1000 }), /未返回有效内容/);
  mode = 'reasoning';
  await assert.rejects(complete({ ...args(url), idleTimeoutMs: 100, timeoutMs: 180 }), /请求超时/);
});

test('已收到正文后停滞或超时说明回复未完成，保留正文且不自动重试', async (t) => {
  let calls = 0;
  const url = await server(t, (_req, res) => {
    calls++;
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"已经收到的正文"}}]}\n\n');
    const timer = setInterval(() => res.write(': ping\n\n'), 10);
    res.on('close', () => clearInterval(timer));
  });
  const chunks = [];
  await assert.rejects(
    complete({ ...args(url), idleTimeoutMs: 150, timeoutMs: 2000, onDelta: (value) => chunks.push(value) }),
    (error) => {
      assert.match(error.message, /中途停了.*没有新内容/);
      assert.match(error.message, /保留.*继续追问/);
      assert.doesNotMatch(error.message, /未返回有效内容/);
      return true;
    }
  );
  assert.deepEqual(chunks, ['已经收到的正文']);
  assert.equal(calls, 1);
  await assert.rejects(complete({ ...args(url), idleTimeoutMs: 2000, timeoutMs: 150 }), /请求超时.*回复尚未完整/);
  assert.equal(calls, 2);
});

test('正文后连接异常断开说明是中断，不误报完全无法连接', async (t) => {
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"已收部分"}}]}\n\n');
    setTimeout(() => res.destroy(), 60);
  });
  let received = '';
  await assert.rejects(
    complete({
      ...args(url),
      onDelta: (value) => {
        received += value;
      }
    }),
    /连接中断.*继续追问/
  );
  assert.equal(received, '已收部分');
});

test('诊断区分空闲超时与完成标记，不记录Key、正文或推理内容', async (t) => {
  let finish = false;
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"reasoning_content":"private thinking"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"private answer"}}]}\n\n');
    if (finish) res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    else {
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20);
      res.on('close', () => clearInterval(timer));
    }
  });
  let diagnostic;
  await assert.rejects(
    complete({
      ...args(url),
      idleTimeoutMs: 150,
      onDiagnostic: (value) => {
        diagnostic = value;
      }
    }),
    /中途停了/
  );
  assert.equal(diagnostic.outcome, 'idle_timeout');
  assert.equal(diagnostic.contentChars, 14);
  assert.equal(diagnostic.contentEvents, 1);
  assert.equal(diagnostic.reasoningEvents, 1);
  assert.ok(diagnostic.heartbeatEvents > 0);
  assert.ok(diagnostic.lastByteMs > diagnostic.lastContentMs);
  assert.equal(diagnostic.finishReason, null);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret-test-key|test-model/);
  finish = true;
  await complete({
    ...args(url),
    onDiagnostic: (value) => {
      diagnostic = value;
    }
  });
  assert.equal(diagnostic.outcome, 'complete');
  assert.equal(diagnostic.finishReason, 'stop');
  assert.equal(diagnostic.doneSeen, false);
  assert.equal(diagnostic.httpStatus, 200);
});

test('诊断中文说明区分无网络数据与只有心跳，不臆测具体上游原因', () => {
  const d = { outcome: 'idle_timeout', elapsedMs: 100000, idleTimeoutMs: 90000, lastByteMs: 10000, contentChars: 100 };
  assert.match(diagnosticText(d), /不能区分服务端停顿、网关或网络中断/);
  assert.match(diagnosticText({ ...d, lastByteMs: 99000 }), /连接仍有数据/);
  assert.match(
    diagnosticText({ outcome: 'complete', firstContentMs: 2500, elapsedMs: 15000, finishReason: 'stop' }),
    /正常完成[\s\S]*2.50 秒[\s\S]*stop/
  );
});
