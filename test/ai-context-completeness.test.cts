const test = require('node:test'),
  assert = require('node:assert/strict');
const { snapshotText, conversationContext, estimateTokens } = require('../dist/features/ai/agent-context');
const { AnalysisAgent } = require('../dist/features/ai/agent');
const { AgentData } = require('../dist/features/ai/agent-data');
const { summarizeConversation } = require('../dist/features/ai/conversation-memory');
const stamp = '2026-11-11T07:00:00Z';
function snapshot() {
  return {
    target: 'sz002475',
    capturedAt: stamp,
    timeZone: 'Asia/Shanghai',
    notes: [],
    quote: { symbol: 'sz002475', price: 52, timestamp: '20261111150000' },
    timeframes: Object.fromEntries(
      ['daily', 'weekly', 'monthly', 'intraday'].map((period) => [
        period,
        {
          date: '2026-11-11',
          state: '偏强',
          source: '测试源',
          adjustment: '前复权',
          confirmedThrough: '2026-11-10',
          forming: true,
          indicators: { MA20: 50, MA60: 52 },
          recentBars: Array.from({ length: 10 }, (_, i) => ({
            time: `2026-11-${11 - i}`,
            close: 52 - i,
            volume: 100 + i
          })),
          recentBarsOrder: '新到旧'
        }
      ])
    ),
    market: {
      amount: 100000000,
      markets: [{ breadth: { advancing: 2000, declining: 3000 } }],
      benchmarks: [{ symbol: 'sh000001', price: 3600, timestamp: '20261111150000' }]
    },
    sectors: {
      applicable: true,
      industry: '消费电子',
      source: '测试板块源',
      rows: Array.from({ length: 47 }, (_, i) => ({
        name: i === 46 ? '消费电子' : `概念${i}`,
        type: i === 46 ? '所属行业' : '相关板块',
        percent: 1.5,
        timestamp: 1794380400,
        detail: '原始来源和日期应保留'.repeat(20)
      }))
    },
    globalMarkets: { quotes: [{ id: '100.NDX', percent: 1, time: stamp }] },
    news: { items: [{ title: '公开消息', publishedAt: stamp }] }
  };
}
const planner = new AgentData({});
const options = (s) => ({
  url: 'https://example.com/v1',
  model: 'mock',
  key: 'mock',
  target: 'sz002475',
  snapshot: s,
  messages: [
    { role: 'system', content: '根据已提供数据分析，缺失先补查' },
    { role: 'user', content: '当前行情快照：\n' + snapshotText(s) },
    { role: 'user', content: '请分析当前股票' }
  ]
});

test('大快照保留全部周期、行情时间及末尾所属行业，不因 token 预算变成空对象', () => {
  const source = snapshot();
  source.agent = { evidence: ['重复工具记录'] };
  source.daily = source.timeframes.daily;
  source.coverage = [{ label: '界面文案' }];
  const sent = JSON.parse(snapshotText(source));
  assert.ok(estimateTokens(sent) > 5500);
  assert.deepEqual(sent.timeframes, source.timeframes);
  assert.deepEqual(sent.market, source.market);
  assert.equal(sent.sectors.rows[46].name, '消费电子');
  assert.equal(sent.sectors.rows[46].timestamp, 1794380400);
  assert.deepEqual(sent.globalMarkets, source.globalMarkets);
  assert.deepEqual(sent.news, source.news);
  assert.equal(sent.agent, undefined);
  assert.equal(sent.daily, undefined);
  assert.equal(sent.omitted, undefined);
});

test('缺口计划仅查缺失项，行业有归属但无报价仍补查；ETF不套用个股板块', () => {
  const s = snapshot();
  assert.deepEqual(planner.missingQueries(s, 'sz002475', '分析走势'), []);
  s.sectors.rows = [];
  assert.deepEqual(
    planner.missingQueries(s, 'sz002475', '分析走势').map((q) => q.name),
    ['get_environment']
  );
  delete s.timeframes.daily;
  delete s.market;
  assert.deepEqual(
    planner.missingQueries(s, 'sz002475', '分析走势').map((q) => q.label),
    ['所属板块', '大盘与涨跌家数', '日线']
  );
  assert.deepEqual(planner.missingQueries(s, 'sz002475', '解释一下MACD是什么意思'), []);
  assert.ok(!planner.missingQueries(s, 'sh510300', '分析走势').some((q) => q.label === '所属板块'));
});

test('首次回答前自动补齐行业和日线，同轮模型再次查相同板块复用结果', async () => {
  const s = snapshot(),
    full = snapshot(),
    queries = [],
    requests = [];
  s.sectors = { missing: true, applicable: true };
  delete s.timeframes.daily;
  s.notes = ['日线缺失，不推断该周期走势。'];
  let updated;
  const result = await new AnalysisAgent().run({
    ...options(s),
    onSnapshot: (value) => (updated = value),
    data: {
      missingQueries: planner.missingQueries.bind(planner),
      execute: async (name, args) => {
        queries.push(name);
        return name === 'get_environment'
          ? { sectors: full.sectors }
          : {
              period: 'daily',
              summary: full.timeframes.daily,
              bars: full.timeframes.daily.recentBars.slice().reverse()
            };
      }
    },
    request: async (args) => {
      requests.push(args);
      const actual = JSON.parse(
        args.messages
          .find((m) => m.content.startsWith('当前行情快照'))
          .content.split('\n')
          .slice(1)
          .join('\n')
      );
      assert.equal(actual.sectors.industry, '消费电子');
      assert.equal(actual.sectors.rows.length, 47);
      assert.equal(actual.timeframes.daily.date, '2026-11-11');
      assert.ok(!actual.notes.some((n) => n.startsWith('日线缺失')));
      if (requests.length === 1)
        return {
          content: '',
          calls: [
            {
              id: 'sector',
              type: 'function',
              function: { name: 'get_environment', arguments: JSON.stringify({ symbol: 'sz002475', scope: 'sector' }) }
            }
          ],
          usage: { prompt_tokens: 18000, completion_tokens: 20 }
        };
      assert.equal(JSON.parse(args.messages.find((m) => m.role === 'tool').content).sectors.rows.length, 47);
      return { content: '已依据行业和日线进行分析', calls: [] };
    }
  });
  assert.equal(result.report.queries, 2);
  assert.equal(requests.length, 2);
  assert.equal(queries.length, 2);
  assert.equal(updated.timeframes.daily.recentBars.length, 10);
});

test('数据源失败后带原因作答，自动补查仍受六次上限限制；取消时不再请求模型', async () => {
  const s = { target: 'sz002475', notes: [], timeframes: {} },
    queries = [];
  const result = await new AnalysisAgent().run({
    ...options(s),
    data: {
      missingQueries: planner.missingQueries.bind(planner),
      execute: async (name) => {
        queries.push(name);
        return { missing: true, error: '数据源 HTTP 501，冷却中' };
      }
    },
    request: async (args) => {
      assert.equal(args.tools.length, 0);
      assert.match(JSON.stringify(args.messages), /HTTP 501/);
      return { content: '补查失败，现有资料不足，不能判断', calls: [] };
    }
  });
  assert.equal(queries.length, 6);
  assert.equal(result.report.limited, true);
  const abort = new AbortController();
  let called = false;
  await assert.rejects(
    new AnalysisAgent().run({
      ...options(s),
      signal: abort.signal,
      data: {
        missingQueries: () => [{ name: 'get_environment', args: { scope: 'sector' }, label: '所属板块' }],
        execute: async () => {
          abort.abort();
          return { missing: true };
        }
      },
      request: async () => {
        called = true;
        return { content: '无效', calls: [] };
      }
    }),
    { name: 'AbortError' }
  );
  assert.equal(called, false);
});

test('普通长度对话不提前压缩，摘要失败后完整保留旧问答而非句子节选', async () => {
  const history = Array.from({ length: 24 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: '有条件的完整分析和观察依据。'.repeat(4) + i
  }));
  let called = false;
  const result = await summarizeConversation(
    history,
    undefined,
    { url: 'https://example.com', model: 'mock', key: 'mock' },
    async () => {
      called = true;
      throw Error('offline');
    }
  );
  assert.equal(result.attempted, false);
  assert.equal(called, false);
  assert.deepEqual(conversationContext(history), history);
});
