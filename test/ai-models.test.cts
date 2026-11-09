const test = require('node:test'),
  assert = require('node:assert/strict'),
  http = require('node:http');
const { modelsEndpoint, parseModelIds, listModels } = require('../dist/features/ai/models.js');
async function server(t, handle) {
  const s = http.createServer(handle);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return `http://127.0.0.1:${s.address().port}/v1`;
}
const key = 'fixture-secret-models-only';
test('模型接口沿用完整前缀，拒绝外部明文HTTP和URL凭据', () => {
  for (const [input, expected] of [
    ['https://example.com/v1/', 'https://example.com/v1/models'],
    ['https://example.com/chat/completions', 'https://example.com/models'],
    ['https://example.com/custom/api/chat/completions/', 'https://example.com/custom/api/models'],
    ['http://127.0.0.1:62003/v1', 'http://127.0.0.1:62003/v1/models']
  ])
    assert.equal(modelsEndpoint(input), expected);
  for (const value of [
    'http://example.com/v1',
    'https://key@example.com',
    'https://example.com?key=a',
    'https://example.com/#a'
  ])
    assert.throws(() => modelsEndpoint(value));
});
test('列表去重排序、过滤无效ID，允许空列表并限制条数', () => {
  assert.deepEqual(
    parseModelIds({
      data: [{ id: 'zcode/GLM-5.3-Flash' }, { id: ' b ' }, { id: 'b' }, null, { id: {} }, { id: 'x\ny' }, { id: '' }]
    }),
    ['b', 'zcode/GLM-5.3-Flash']
  );
  assert.deepEqual(parseModelIds({ data: [] }), []);
  assert.throws(() => parseModelIds({ models: [] }), /格式不兼容/);
  assert.equal(parseModelIds({ data: Array.from({ length: 2200 }, (_, i) => ({ id: `model-${i}` })) }).length, 2000);
});
test('GET模型列表带鉴权，分块中文正确解码且不返回被回显的Key', async (t) => {
  let seen;
  const url = await server(t, (req, res) => {
    seen = { method: req.method, path: req.url, auth: req.headers.authorization };
    const content = Buffer.from(JSON.stringify({ data: [{ id: '自定义模型' }, { id: key }, { id: 'model-a' }] }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    for (let i = 0; i < content.length; i += 2) res.write(content.subarray(i, i + 2));
    res.end();
  });
  const result = await listModels({ url, key });
  assert.equal(result.length, 2);
  assert.ok(result.includes('自定义模型'));
  assert.deepEqual(seen, { method: 'GET', path: '/v1/models', auth: `Bearer ${key}` });
});
test('错误响应使用固定提示，不泄露服务商正文；重定向不会带Key追随', async (t) => {
  let status = 401,
    count = 0;
  const url = await server(t, (_req, res) => {
    count++;
    res.writeHead(status, { Location: '/other' });
    res.end(key);
  });
  for (const [code, hint] of [
    [401, /Key 无效/],
    [403, /权限/],
    [404, /不支持/],
    [405, /不支持/],
    [429, /频繁/],
    [500, /暂不可用/],
    [302, /重定向/]
  ]) {
    status = code;
    await assert.rejects(listModels({ url, key }), (error) => {
      assert.match(error.message, hint);
      assert.ok(!error.message.includes(key));
      return true;
    });
  }
  assert.equal(count, 7);
});
test('空Key不发送请求，畸形JSON/格式/大响应有明确错误，网络异常不透传', async () => {
  const url = 'https://example.com/v1';
  await assert.rejects(
    listModels({
      url,
      key: '',
      request: () => {
        throw Error('must not send');
      }
    }),
    /先填写/
  );
  for (const [body, hint] of [
    ['<html>login</html>', /有效的模型列表/],
    ['{}', /格式不兼容/],
    [' '.repeat(2 * 1024 * 1024 + 1), /响应过大/]
  ])
    await assert.rejects(listModels({ url, key, request: async () => new Response(body) }), hint);
  await assert.rejects(
    listModels({
      url,
      key,
      request: async () => {
        throw Error(`服务商泄露 ${key}`);
      }
    }),
    (error) => {
      assert.match(error.message, /连接失败/);
      assert.ok(!error.message.includes(key));
      return true;
    }
  );
});
test('获取超时和取消都会终止请求，取消后不再请求或误报成功', async (t) => {
  const url = await server(t, () => {});
  await assert.rejects(listModels({ url, key, timeoutMs: 50 }), /超时/);
  const abort = new AbortController();
  const result = listModels({ url, key, signal: abort.signal });
  abort.abort();
  await assert.rejects(result, (error) => error.name === 'AbortError');
  await assert.rejects(
    listModels({
      url,
      key,
      signal: abort.signal,
      request: () => {
        throw Error('must not send');
      }
    }),
    /取消/
  );
});
