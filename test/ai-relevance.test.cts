const test = require('node:test'),
  assert = require('node:assert/strict');
const { AnalysisEnvironment } = require('../dist/features/ai/environment');
const { AnalysisContext } = require('../dist/features/ai/context');
const { AgentData, applyEvidence } = require('../dist/features/ai/agent-data');
const { AnalysisAgent } = require('../dist/features/ai/agent');
const { snapshotText } = require('../dist/features/ai/agent-context');
const { BUILTIN_INDICES } = require('../dist/features/global-indices/data');
const NOW = Date.parse('2026-11-17T02:00:00Z');
const quote = (code, at = NOW) => ({
  code,
  price: 100,
  priceText: '100',
  percent: 1,
  delta: 1,
  previousClose: null,
  previousSettlement: 99,
  settlement: null,
  volume: 1000,
  openInterest: 500,
  open: 99,
  high: 101,
  low: 98,
  timestamp: at / 1000,
  date: new Date(at + 8 * 3600000).toISOString().slice(0, 10),
  time: new Date(at + 8 * 3600000).toISOString().slice(11, 19)
});
const entry = (code, name) => ({ code, name, unit: '元/吨', aliases: name, market: 'domesticFutures' });
function environment() {
  const calls = [],
    searches = [];
  const env = new AnalysisEnvironment({
    now: () => new Date(NOW),
    globals: { selectedIds: ['100.FTSE'], quotes: new Map() },
    globalProvider: {
      load: async (ids) => {
        calls.push({ type: 'global', ids });
        return {
          quotes: new Map(
            ids.map((id) => [
              id,
              {
                ...BUILTIN_INDICES.find((e) => e.id === id),
                price: 100,
                percent: 1,
                delta: 1,
                previousClose: 99,
                open: 99,
                high: 101,
                low: 98,
                timestamp: NOW / 1000
              }
            ])
          )
        };
      }
    },
    commodityProvider: {
      load: async (codes) => {
        calls.push({ type: 'commodity', codes });
        return { quotes: new Map(codes.map((code) => [code, quote(code)])) };
      }
    },
    futuresSearch: {
      local: (query) => (query === '生猪' ? [entry('LH0', '生猪主连')] : []),
      search: async (query) => {
        searches.push(query);
        return query === '玉米'
          ? [entry('C2611', '玉米2611'), entry('C0', '玉米主连'), entry('CS0', '淀粉'), entry('RR0', '粳米')]
          : [entry('M0', '豆粕主连'), entry('RM0', '菜粕主连')];
      }
    },
    newsProvider: { load: async () => [] }
  });
  return { env, calls, searches, signal: new AbortController().signal };
}
function core() {
  return {
    target: 'sz002714',
    capturedAt: new Date(NOW).toISOString(),
    timeZone: 'Asia/Shanghai',
    notes: [],
    quote: { symbol: 'sz002714', name: '牧原股份', price: 50, timestamp: '20261117100000' },
    timeframes: Object.fromEntries(
      ['daily', 'weekly', 'monthly', 'intraday'].map((p) => [p, { date: '2026-11-17', state: '整理' }])
    ),
    sectors: { industry: '养殖业', rows: [{ name: '养殖业', type: '所属行业', percent: 1, timestamp: NOW / 1000 }] },
    market: {
      amount: 1000,
      markets: [{ breadth: { advancing: 1000, declining: 1000 } }],
      benchmarks: [{ price: 3000 }]
    }
  };
}

test('牧原分析首次请求无铜金油和外围，模型选择生猪后只查询该品种，并说明关联与来源', async () => {
  const f = environment(),
    initial = core();
  const source = { collect: async () => initial, environment: f.env };
  const data = new AgentData(source, () => NOW);
  const prepared = await data.prepare('sz002714', null, undefined, f.signal);
  assert.deepEqual(f.calls, []);
  const requests = [],
    statuses = [];
  const args = { query: '生猪', reason: '结合养殖行业，核对生猪期货对价格预期的参考' };
  const result = await new AnalysisAgent().run({
    url: 'https://example.com/v1',
    model: 'mock',
    key: 'mock',
    target: 'sz002714',
    data,
    snapshot: prepared,
    signal: f.signal,
    onStatus: (s) => statuses.push(s),
    messages: [
      { role: 'system', content: '按关联查询' },
      { role: 'user', content: '当前行情快照：\n' + snapshotText(prepared) },
      { role: 'user', content: '分析牧原股份，需要时查询产业链数据' }
    ],
    request: async (options) => {
      requests.push(options);
      if (requests.length === 1) {
        assert.doesNotMatch(options.messages[1].content, /commodities|globalMarkets|黄金|铜|原油/);
        const tool = options.tools.find((t) => t.function.name === 'get_commodity');
        assert.deepEqual(tool.function.parameters.required, ['query', 'reason']);
        return {
          content: '',
          usage: { prompt_tokens: 200, completion_tokens: 30 },
          calls: [
            { id: 'pig', type: 'function', function: { name: 'get_commodity', arguments: JSON.stringify(args) } },
            {
              id: 'pig-duplicate',
              type: 'function',
              function: { name: 'get_commodity', arguments: JSON.stringify(args) }
            }
          ]
        };
      }
      const evidence = JSON.parse(options.messages.find((m) => m.role === 'tool').content);
      assert.equal(evidence.commodities.quotes[0].code, 'LH0');
      assert.equal(evidence.commodities.quotes[0].time, new Date(NOW).toISOString());
      assert.match(evidence.commodities.quotes[0].source, /新浪/);
      assert.match(evidence.commodities.notice, /不能替代现货/);
      assert.doesNotMatch(JSON.stringify(evidence), /CAD|XAU|OIL|NQ/);
      return {
        content: '已结合生猪期货参考，区分期货预期与公司盈利。',
        calls: [],
        usage: { prompt_tokens: 300, completion_tokens: 30 }
      };
    }
  });
  assert.equal(result.report.queries, 1);
  assert.deepEqual(f.calls, [{ type: 'commodity', codes: ['LH0'] }]);
  assert.match(statuses.join(''), /按需查询：生猪/);
  assert.equal(applyEvidence(prepared, 'sz002714', result.evidence).commodities.quotes[0].code, 'LH0');
});

test('品种名称可远程搜索主连；歧义返回候选，缺少关联或不合法参数时不发请求', async () => {
  const f = environment(),
    data = new AgentData({ environment: f.env }, () => NOW);
  const value = await data.execute(
    'get_commodity',
    { query: '玉米', reason: '核对饲料原料参考' },
    'sz002714',
    f.signal
  );
  assert.deepEqual(f.searches, ['玉米']);
  assert.deepEqual(f.calls, [{ type: 'commodity', codes: ['C0'] }]);
  assert.equal(value.commodities.quotes[0].name, '玉米主连');
  const ambiguous = await data.execute(
    'get_commodity',
    { query: '粕类', reason: '比较饲料原料' },
    'sz002714',
    f.signal
  );
  assert.equal(ambiguous.commodities.candidates.length, 2);
  assert.equal(f.calls.length, 1);
  for (const [name, args] of [
    ['get_commodity', { query: '铜' }],
    ['get_commodity', { query: '铜', reason: '' }],
    ['get_commodity', { query: 'https://attacker', reason: '测试' }],
    ['get_commodity', { query: '生猪', reason: '测试', url: 'https://attacker' }],
    ['get_environment', { scope: 'global', region: 'unknown' }],
    ['get_environment', { scope: 'sector', region: 'us' }]
  ])
    await assert.rejects(data.execute(name, args, 'sz002714', f.signal));
  assert.equal(f.calls.length, 1);
});

test('按日本查询只取日经和对应期货；显式查询也不附带铜油金银及其他地区缓存', async () => {
  const f = environment(),
    data = new AgentData({ environment: f.env }, () => NOW);
  const result = await data.execute('get_environment', { scope: 'global', region: 'jp' }, 'sz002714', f.signal);
  assert.deepEqual(f.calls, [
    { type: 'global', ids: ['100.N225'] },
    { type: 'commodity', codes: ['NK'] }
  ]);
  assert.equal(result.commodities, undefined);
  assert.deepEqual(
    result.globalMarkets.quotes.map((q) => q.id),
    ['100.N225']
  );
  assert.deepEqual(
    result.globalMarkets.futures.map((q) => q.code),
    ['NK']
  );
  assert.deepEqual(
    result.globalMarkets.sessions.map((s) => s.id),
    ['jp']
  );
  const news = await f.env.load('sz002714', f.signal, '牧原股份', ['news']);
  assert.equal(news.globalMarkets, undefined);
  assert.equal(news.commodities, undefined);
  assert.equal(news.market, undefined);
  assert.equal(news.sectors, undefined);
  assert.doesNotMatch(news.notes.join(''), /全球指数不可用|大盘.*未获取|所属板块查询失败/);
});

test('首次采集的边界不接受辅助源顺带返回的无关商品、外围和新闻', async () => {
  let sections;
  const context = new AnalysisContext({
    now: () => new Date(NOW),
    chartProvider: { load: async () => ({ bars: [] }) },
    quoteProvider: { load: async () => ({ quotes: new Map([['sz002714', core().quote]]) }) },
    environment: {
      load: async (_symbol, _signal, _name, requested) => {
        sections = requested;
        return {
          sectors: { applicable: false },
          globalMarkets: { quotes: [{ name: '纳指' }] },
          commodities: { quotes: [{ name: '铜' }] },
          news: { items: ['无关快讯'] },
          notes: []
        };
      }
    }
  });
  const snapshot = await context.collect('sz002714');
  assert.deepEqual(sections, ['market', 'sectors']);
  assert.equal(snapshot.commodities, undefined);
  assert.equal(snapshot.globalMarkets, undefined);
  assert.equal(snapshot.news, undefined);
});

test('商品缺失不缓存；失败回退保留原时间且不能当实时，恢复后再次获取', async () => {
  const f = environment();
  let now = NOW,
    count = 0,
    mode = 'missing';
  f.env.now = () => new Date(now);
  f.env.commodityProvider = {
    load: async (codes) => {
      count++;
      if (mode === 'missing') return { quotes: new Map(), errors: new Map() };
      assert.deepEqual(codes, ['LH0']);
      return { quotes: new Map([['LH0', quote('LH0', now)]]) };
    }
  };
  const data = new AgentData({ environment: f.env }, () => now);
  const args = { query: '生猪', reason: '核查养殖价格预期' };
  const missing = await data.execute('get_commodity', args, 'sz002714', f.signal);
  assert.equal(missing.commodities.missing, true);
  mode = 'valid';
  const one = await data.execute('get_commodity', args, 'sz002714', f.signal);
  assert.equal(count, 2);
  assert.equal(one.commodities.quotes[0].currentReference, true);
  now += 1000;
  await data.execute('get_commodity', args, 'sz002714', f.signal);
  assert.equal(count, 2);
  now += 20000;
  mode = 'missing';
  const fallback = await data.execute('get_commodity', args, 'sz002714', f.signal);
  assert.equal(count, 3);
  assert.equal(fallback.fetchFailed, true);
  assert.equal(fallback.commodities.fetchFailed, true);
  assert.equal(fallback.commodities.quotes[0].currentReference, false);
  assert.equal(fallback.commodities.quotes[0].time, one.commodities.quotes[0].time);
  assert.equal(fallback.commodities.quotes[0].fetchedAt, one.commodities.quotes[0].fetchedAt);
  mode = 'valid';
  const recovered = await data.execute('get_commodity', args, 'sz002714', f.signal);
  assert.equal(count, 4);
  assert.equal(recovered.fetchFailed, false);
  assert.equal(recovered.commodities.quotes[0].time, new Date(now).toISOString());
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(data.execute('get_commodity', args, 'sz002714', cancelled.signal));
  assert.equal(count, 4);
});

test('A股盘外仍按20秒更新商品；工具异常回退也不能把旧商品标为当前', async () => {
  const f = environment();
  let now = Date.parse('2026-11-17T13:00:00Z'),
    count = 0,
    fail = false;
  f.env.now = () => new Date(now);
  f.env.commodityProvider = {
    load: async () => {
      count++;
      return { quotes: new Map([['LH0', quote('LH0', now)]]) };
    }
  };
  const relatedQuote = f.env.relatedQuote.bind(f.env);
  f.env.relatedQuote = async (...args) => {
    if (fail) throw Error('offline');
    return relatedQuote(...args);
  };
  const data = new AgentData({ environment: f.env }, () => now);
  const args = { query: '生猪', reason: '核查养殖价格预期' };
  const one = await data.execute('get_commodity', args, 'sz002714', f.signal);
  now += 21000;
  const two = await data.execute('get_commodity', args, 'sz002714', f.signal);
  assert.equal(count, 2);
  assert.notEqual(two.commodities.quotes[0].time, one.commodities.quotes[0].time);
  fail = true;
  const old = await data.execute('get_commodity', args, 'sz002714', f.signal);
  assert.equal(old.fetchFailed, true);
  assert.equal(old.commodities.quotes[0].currentReference, false);
  assert.equal(old.commodities.quotes[0].fetchFailed, true);
  assert.equal(old.commodities.quotes[0].time, two.commodities.quotes[0].time);
});
