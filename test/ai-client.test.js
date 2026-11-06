'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { endpoint, secretId, complete, requestBody } = require('../src/ai-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function server(t, handle) {
  const s = http.createServer(handle); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => { s.closeAllConnections(); s.close(); }); return `http://127.0.0.1:${s.address().port}/v1`;
}
const args = url => ({ url, model: 'test-model', key: 'secret-test-key', messages: [{ role: 'user', content: '测试' }] });
test('API路径规范化，密钥绑定完整接口，拒绝外部HTTP和地址内凭据', () => {
  assert.equal(endpoint('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.equal(endpoint('https://example.com/chat/completions'), 'https://example.com/chat/completions');
  assert.equal(secretId('https://example.com/v1/'), secretId('https://example.com/v1/chat/completions'));
  assert.notEqual(secretId('https://example.com/a'), secretId('https://example.com/b'));
  for (const url of ['http://example.com', 'https://key@example.com', 'https://example.com?api_key=key', 'https://example.com/#hash', 'file:///tmp']) assert.throws(() => endpoint(url));
});
test('SSE处理拆分的UTF8、CRLF、心跳和结束标记，按Chat Completions协议发送', async t => {
  let request;
  const url = await server(t, async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    request = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const raw = Buffer.from(': ping\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"中文分析"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
    for (let i = 0; i < raw.length; i += 3) { res.write(raw.subarray(i, i + 3)); await delay(1); } res.end();
  });
  let streamed = '';
  assert.equal(await complete({ ...args(url), onDelta: s => { streamed += s; } }), '中文分析');
  assert.equal(streamed, '中文分析'); assert.equal(request.path, '/v1/chat/completions'); assert.equal(request.auth, 'Bearer secret-test-key');
  assert.equal(request.body.stream, true); assert.equal(request.body.model, 'test-model');
});
test('兼容忽略stream的JSON接口，空内容和截断流不能算成功', async t => {
  let mode = 'json';
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', mode === 'json' ? 'application/json' : 'text/event-stream');
    res.end(mode === 'json' ? JSON.stringify({ choices: [{ message: { content: '正常回复' } }] }) : mode === 'empty' ? 'data: [DONE]\n\n' : 'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
  });
  assert.equal(await complete(args(url)), '正常回复');
  mode = 'empty'; await assert.rejects(complete(args(url)), /未返回/);
  mode = 'cut'; await assert.rejects(complete(args(url)), /中断/);
});
test('错误信息不回显服务商内容，重定向不转发Key', async t => {
  let status = 401, redirected = 0;
  const url = await server(t, (req, res) => {
    if (req.url === '/stolen') redirected++;
    res.writeHead(status, { Location: '/stolen' }); res.end('secret-test-key and private provider response');
  });
  for (const code of [401, 403, 404, 429, 500, 302]) { status = code; await assert.rejects(complete(args(url)), error => error.message.includes(String(code)) && !error.message.includes('secret-test-key')); }
  assert.equal(redirected, 0);
});
test('取消、超时和超长输出均中止请求', async t => {
  let mode = 'slow';
  const url = await server(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); if (mode === 'large') res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(64001) } }] }) + '\n\n'); });
  const abort = new AbortController(), promise = complete({ ...args(url), signal: abort.signal }); abort.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  await assert.rejects(complete({ ...args(url), timeoutMs: 30 }), /超时/);
  mode = 'large'; await assert.rejects(complete(args(url)), /过长/);
});
test('长度截断和流内错误不伪装成分析完成', async t => {
  let error = false;
  const url = await server(t, (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify(error ? { error: { message: 'secret-test-key' } } : { choices: [{ delta: { content: '截断内容' }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n'); });
  await assert.rejects(complete(args(url)), /长度上限/);
  error = true; await assert.rejects(complete(args(url)), e => /服务返回错误/.test(e.message) && !e.message.includes('secret-test-key'));
});

test('OpenAI使用现代输出上限并预留推理额度，其他兼容接口保留原参数', () => {
  const messages = [{ role: 'user', content: '测试' }];
  const body = requestBody('https://api.openai.com/v1/chat/completions', 'gpt-6.1-terra', messages, 3000);
  assert.equal(body.max_tokens, undefined); assert.equal(body.max_completion_tokens, 7096); assert.equal(body.messages, messages);
  assert.equal(requestBody('https://api.openai.com/v1/chat/completions', 'gpt-4o', messages, 3000).max_completion_tokens, 3000);
  assert.equal(requestBody('https://api.openai.com/v1/chat/completions', 'gpt-6.1-terra', messages, 64).max_completion_tokens, 1088);
  assert.equal(requestBody('https://compatible.example/v1/chat/completions', 'gpt-6.1-terra', messages, 3000).max_tokens, 3000);
});

test('推理阶段只上报状态，不泄露或混入正文；完成信号后无需等连接关闭', async t => {
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"分析结果"},"finish_reason":"stop"}]}\n\n');
    // Deliberately leave the connection open, without [DONE].
  });
  const progress = [], chunks = [];
  assert.equal(await complete({ ...args(url), timeoutMs: 1000, onProgress: p => progress.push(p), onDelta: p => chunks.push(p) }), '分析结果');
  assert.deepEqual(progress, ['connecting', 'waiting', 'reasoning', 'answering']); assert.deepEqual(chunks, ['分析结果']);
});

test('网关漏写SSE类型仍能逐段接收，推理无正文与错误协议给出明确原因', async t => {
  let mode = 'sse';
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'sse') res.end('data: {"choices":[{"delta":{"content":"兼容流"},"finish_reason":"stop"}]}\n\n');
    if (mode === 'reasoning') res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'private reasoning' }, finish_reason: 'stop' }] }));
    if (mode === 'limit') res.end(JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }] }));
    if (mode === 'responses') res.write('data: {"type":"response.created"}\n\n');
  });
  assert.equal(await complete(args(url)), '兼容流');
  mode = 'reasoning'; await assert.rejects(complete(args(url)), /只返回了推理过程/);
  mode = 'limit'; await assert.rejects(complete(args(url)), /尚未返回正文/);
  mode = 'responses'; await assert.rejects(complete(args(url)), /Responses 格式/);
});

test('心跳不能无限延长等待，有效推理重置空闲计时但仍受总时限约束', async t => {
  let mode = 'heartbeat';
  const url = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.write(': ready\n\n');
    const timer = setInterval(() => res.write(mode === 'heartbeat' ? ': ping\n\n' : 'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n'), 10);
    res.on('close', () => clearInterval(timer));
  });
  await assert.rejects(complete({ ...args(url), idleTimeoutMs: 70, timeoutMs: 1000 }), /未返回有效内容/);
  mode = 'reasoning'; await assert.rejects(complete({ ...args(url), idleTimeoutMs: 100, timeoutMs: 180 }), /请求超时/);
});
