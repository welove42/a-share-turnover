'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { AnalysisEnvironment, WORLD_IDS, headlines } = require('../dist/features/ai/environment.js');
const { AnalysisContext, BENCHMARKS, SYSTEM } = require('../dist/features/ai/context.js');
const { AiSectorProvider, parseMembership, parseBoardQuotes } = require('../dist/features/ai/sector-data.js');
const { BUILTIN_INDICES } = require('../dist/features/global-indices/data.js');
const { attempt } = require('../dist/features/ai/data.js');
const { AiQuoteProvider, parseQuotes: parseBackupQuotes } = require('../dist/features/ai/quote-data.js');
const NOW = Date.parse('2026-11-05T06:30:00Z'),
  stamp = NOW / 1000;
const snapshot = () => ({
  date: '2026-11-05',
  fetchedAt: new Date(NOW).toISOString(),
  amount: 1000000000000,
  previousDate: '2026-11-04',
  comparisonTime: '14:30',
  sameTime: { percent: 25, current: 1000, previous: 800, delta: 200 },
  markets: ['sh000002', 'sz399107'].map((symbol) => ({
    symbol,
    amount: 500000000000,
    timestamp: '20261105143000',
    percent: 1,
    breadth: { advancing: 2000, declining: 900, unchanged: 100 }
  }))
});
function globalQuote(id = '100.NDX', timestamp = stamp) {
  return {
    ...BUILTIN_INDICES.find((q) => q.id === id),
    price: 20000,
    percent: 1,
    delta: 200,
    previousClose: 19800,
    open: 19900,
    high: 20100,
    low: 19800,
    timestamp,
    source: 'eastmoney',
    timestampKind: 'quote'
  };
}
function commodityQuote(code) {
  return {
    code,
    price: 100,
    priceText: '100',
    percent: 1,
    delta: 1,
    previousClose: 99,
    open: 99,
    high: 101,
    low: 98,
    timestamp: stamp,
    date: '2026-11-05',
    time: '14:30:00'
  };
}
function newsItem(id, title, when = NOW) {
  return {
    key: 'eastmoney:' + id,
    id,
    source: 'eastmoney',
    title,
    body: title + '。公开测试新闻。',
    stocks: '',
    publishedAt: when
  };
}
const board = () => ({
  applicable: true,
  industry: '白酒Ⅱ',
  source: '东方财富',
  fetchedAt: new Date(NOW).toISOString(),
  total: 2,
  rows: [
    { code: 'BK1277', name: '白酒Ⅱ', percent: 1.5, timestamp: stamp },
    { code: 'BK0002', name: '相关概念', percent: 2, timestamp: stamp }
  ]
});
function fixture(overrides = {}) {
  const calls = [],
    config = {
      now: () => new Date(NOW),
      marketProvider: {
        load: async () => {
          calls.push('market');
          return snapshot();
        }
      },
      globalProvider: {
        load: async (ids) => {
          calls.push(ids);
          return { quotes: new Map(ids.map((id) => [id, globalQuote(id)])) };
        }
      },
      commodityProvider: {
        load: async (codes) => ({ quotes: new Map(codes.map((code) => [code, commodityQuote(code)])) })
      },
      sectorProvider: { load: async () => board() },
      newsProvider: { load: async () => [newsItem('1', '美联储利率决议'), newsItem('2', '白酒Ⅱ行业消息')] },
      ...overrides
    };
  return { env: new AnalysisEnvironment(config), calls };
}
test('个股分析自动收集大盘、真实所属板块、全球基准、商品和快讯，不依赖展开的自选栏目', async () => {
  const selectedIds = ['100.NDX'],
    stocks = { quotes: new Map(), config: { symbols: ['sh600519'] } };
  const { env, calls } = fixture({ globals: { selectedIds } });
  let requested;
  const context = new AnalysisContext({
    historyProvider: {
      load: async () => {
        throw new Error('历史测试源不可用');
      }
    },
    stocks,
    environment: env,
    now: () => new Date(NOW),
    quoteProvider: {
      load: async (symbols) => {
        requested = symbols;
        return {
          quotes: new Map(
            symbols.map((symbol) => [
              symbol,
              {
                symbol,
                name: symbol,
                price: 100,
                percent: symbol === 'sh600519' ? 3 : 1,
                timestamp: '20261105143000',
                date: '2026-11-05'
              }
            ])
          )
        };
      }
    },
    chartProvider: { load: async () => ({ bars: [], secret: 'private' }) }
  });
  const result = await context.collect('sh600519');
  assert.equal(result.market.amount, 1000000000000);
  assert.equal(result.market.benchmarks.length, 4);
  assert.ok(Number.isFinite(result.market.temperature.score));
  assert.equal(result.sectors.industry, '白酒Ⅱ');
  assert.equal(result.globalMarkets.quotes.length, 10);
  assert.equal(result.commodities.quotes.length, 4);
  assert.equal(result.news.items.length, 2);
  assert.deepEqual(calls.find(Array.isArray), WORLD_IDS);
  assert.deepEqual(selectedIds, ['100.NDX']);
  assert.deepEqual(requested, ['sh600519', ...BENCHMARKS]);
  assert.equal(result.relativeStrength.comparisons.find((r) => r.name === '白酒Ⅱ').difference, 1.5);
  assert.equal(result.coverage.length, 7);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.match(SYSTEM, /触|条件/);
  assert.match(SYSTEM, /全球市场/);
  assert.match(SYSTEM, /不可信数据/);
});
test('接口失败保留缓存的原时间，不把抓取时间当报价时间；部分指数失败保留其他结果', async () => {
  let now = NOW,
    failing = false;
  const { env } = fixture({
    now: () => new Date(now),
    globalProvider: {
      load: async () => {
        if (failing) throw new Error('offline');
        return { quotes: new Map([['100.NDX', { ...globalQuote(), source: 'sina', timestampKind: 'updated' }]]) };
      }
    }
  });
  const first = await env.load('sh600519');
  failing = true;
  now += 70000;
  const second = await env.load('sh600519');
  assert.equal(first.globalMarkets.quotes.length, 1);
  assert.equal(second.globalMarkets.missing.length, 9);
  const q = second.globalMarkets.quotes[0];
  assert.equal(q.timestamp, stamp);
  assert.equal(q.cached, true);
  assert.equal(q.time, new Date(NOW).toISOString());
  assert.equal(q.fetchedAt, first.globalMarkets.quotes[0].fetchedAt);
  assert.match(q.timeKind, /来源更新时间/);
});
test('单个全球接口超时也保留超时前成功的报价，所有背景源均有截止时间', async () => {
  const { env } = fixture({
    timeoutMs: 25,
    globalProvider: {
      load: async (_ids, signal, onQuote) => {
        onQuote(globalQuote());
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('超时'))));
      }
    }
  });
  const data = await env.load('sh600519');
  assert.equal(data.globalMarkets.quotes.length, 1);
  assert.equal(data.globalMarkets.quotes[0].cached, false);
  assert.equal(data.sectors.rows.length, 2);
  assert.equal(data.market.amount, 1000000000000);
});
test('老板键取消时所有背景请求停止，迟到的接口结果不能写入缓存', async () => {
  const signals = [],
    slow = {
      load: async (...args) => {
        signals.push(args.find((v) => v instanceof AbortSignal));
        return new Promise(() => {});
      }
    };
  const { env } = fixture({
    marketProvider: slow,
    globalProvider: slow,
    commodityProvider: slow,
    sectorProvider: slow,
    newsProvider: slow
  });
  const abort = new AbortController(),
    pending = env.load('sh600519', abort.signal);
  await new Promise((r) => setImmediate(r));
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(signals.length, 5);
  assert.ok(signals.every((s) => s.aborted));
  assert.equal(env.cache.size, 0);
  const canceled = new AbortController();
  canceled.abort();
  let invoked = false;
  await assert.rejects(
    attempt(async () => {
      invoked = true;
    }, canceled.signal),
    { name: 'AbortError' }
  );
  assert.equal(invoked, false);
});
test('外围齐全也不能在个股行情全部缺失时调用分析；不输出错时板块强弱差', async () => {
  const { env } = fixture({
    sectorProvider: {
      load: async () => ({ ...board(), rows: board().rows.map((r) => ({ ...r, timestamp: stamp - 86400 })) })
    }
  });
  const context = new AnalysisContext({
    historyProvider: {
      load: async () => {
        throw new Error('历史测试源不可用');
      }
    },
    environment: env,
    now: () => new Date(NOW),
    quoteProvider: { load: async () => ({ quotes: new Map() }) },
    chartProvider: { load: async () => ({ bars: [] }) }
  });
  await assert.rejects(context.collect('sh600519'), /暂无可用行情/);
  context.quoteProvider.load = async () => ({
    quotes: new Map([['sh600519', { symbol: 'sh600519', percent: 3, timestamp: '20261105143000' }]])
  });
  assert.equal((await context.collect('sh600519')).relativeStrength.comparisons.length, 0);
});
test('快讯优先行业和宏观，排除过期或未来内容并限制长度、数量', () => {
  const list = Array.from({ length: 30 }, (_, i) => newsItem(String(i), '其他新闻' + i, NOW - i * 1000));
  list.push(
    newsItem('macro', '美联储降息', NOW - 40000),
    newsItem('related', '白酒Ⅱ测试', NOW - 50000),
    newsItem('old', '白酒Ⅱ旧新闻', NOW - 49 * 3600000),
    newsItem('future', '未来', NOW + 3600000)
  );
  list[0].body = 'x'.repeat(5000);
  const selected = headlines(list, ['白酒Ⅱ'], NOW);
  assert.equal(selected.length, 12);
  assert.ok(selected.some((n) => n.id === 'related' && n.related));
  assert.ok(selected.some((n) => n.id === 'macro'));
  assert.ok(selected.every((n) => !['old', 'future'].includes(n.id) && n.summary.length <= 600));
});
const payload = () => ({
  rc: 0,
  data: { total: 1, diff: [{ f12: 'BK1277', f14: '白酒Ⅱ', f3: 1.5, f6: 10000, f124: stamp }] }
});
test('所属板块按当前股票查询，不使用排行榜；缓存按股票隔离，ETF不猜归属', async () => {
  const urls = [];
  const provider = new AiSectorProvider({
    now: () => NOW,
    request: async (url) => {
      urls.push(url);
      return url.includes('/stock/get') ? { data: { f57: '600519', f127: '白酒Ⅱ' } } : payload();
    }
  });
  const first = await provider.load('sh600519');
  assert.equal(first.industry, '白酒Ⅱ');
  assert.equal(first.rows[0].timestamp, stamp);
  assert.ok(urls.some((url) => url.includes('secid=1.600519') && url.includes('spt=3')));
  assert.ok(urls.every((url) => !url.includes('clist')));
  await provider.load('sh600519');
  assert.equal(urls.length, 2);
  assert.equal((await provider.load('sh600036')).industry, null);
  assert.equal(urls.length, 5);
  assert.equal((await provider.load('sh510300')).applicable, false);
  assert.equal(urls.length, 5);
});
test('板块主源失败回退核心题材资料，不虚构涨幅；全部失败保留带原时间的缓存', async () => {
  let now = NOW,
    failAll = false;
  const provider = new AiSectorProvider({
    now: () => now,
    request: async (url) => {
      if (failAll) throw new Error('offline');
      if (url.includes('/stock/get')) return { data: { f57: '600519', f127: '白酒Ⅱ' } };
      if (url.includes('PageAjax'))
        return {
          ssbk: [
            { SECURITY_CODE: '600519', BOARD_CODE: '1277', BOARD_NAME: '白酒Ⅱ' },
            { SECURITY_CODE: '600036', BOARD_CODE: '9999', BOARD_NAME: '别的股票' }
          ]
        };
      throw new Error('offline');
    }
  });
  const first = await provider.load('sh600519');
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].percent, undefined);
  assert.equal(first.quoteFailure, true);
  failAll = true;
  now += 61000;
  const next = await provider.load('sh600519');
  assert.equal(next.cached, true);
  assert.equal(next.fetchedAt, first.fetchedAt);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(provider.load('sh600519', abort.signal), { name: 'AbortError' });
});
test('板块字段严格校验：缺失涨幅不变成零，资料和行情时间不混淆', () => {
  assert.throws(() =>
    parseMembership({ ssbk: [{ SECURITY_CODE: 'other', BOARD_CODE: '438', BOARD_NAME: '食品' }] }, 'sh600519')
  );
  assert.equal(
    parseMembership({ ssbk: [{ SECURITY_CODE: '600519', BOARD_CODE: '438', BOARD_NAME: '食品' }] }, 'sh600519').rows[0]
      .code,
    'BK0438'
  );
  const data = payload();
  data.data.diff[0].f3 = '-';
  data.data.diff[0].f124 = stamp + 86400;
  const q = parseBoardQuotes(data, NOW).rows[0];
  assert.equal(q.percent, null);
  assert.equal(q.timestamp, null);
});
test('腾讯缺失时只补取缺项，备用报价保留源时间和来源；主源抛错也能回退', async () => {
  let requested,
    thrown = false;
  const primary = {
    load: async () => {
      if (thrown) throw new Error('offline');
      return { quotes: new Map([['sh600519', { symbol: 'sh600519', price: 100 }]]), errors: new Map() };
    }
  };
  const provider = new AiQuoteProvider({
    primary,
    now: () => NOW,
    request: async (url) => {
      requested = new URL(url).searchParams.get('secids');
      return {
        rc: 0,
        data: { diff: [{ f12: '000001', f13: 1, f14: '上证指数', f2: 3500, f3: 1, f18: 3465, f124: stamp }] }
      };
    }
  });
  const result = await provider.load(['sh600519', 'sh000001']);
  assert.equal(requested, '1.000001');
  assert.equal(result.quotes.size, 2);
  assert.equal(result.quotes.get('sh000001').timestamp, '20261105143000');
  assert.equal(result.quotes.get('sh000001').source, '东方财富');
  thrown = true;
  assert.equal((await provider.load(['sh000001'])).quotes.size, 1);
  assert.equal(
    parseBackupQuotes(
      { rc: 0, data: { diff: [{ f12: '000001', f13: 1, f14: '指数', f2: 3500, f124: stamp + 86400 }] } },
      ['sh000001'],
      NOW
    ).size,
    0
  );
});
