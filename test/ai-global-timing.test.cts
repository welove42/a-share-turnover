const test = require('node:test'),
  assert = require('node:assert/strict');
const { regionalSessions, cashTiming, futureTiming } = require('../dist/features/ai/global-timing');
const { AnalysisEnvironment } = require('../dist/features/ai/environment');
const { AgentData } = require('../dist/features/ai/agent-data');
const { BUILTIN_INDICES } = require('../dist/features/global-indices/data');
const { ProfileStore } = require('../dist/features/ai/profile');
const { InterestStore } = require('../dist/features/ai/interests');
const { harness } = require('./vscode-mock.cts');
const NOW = Date.parse('2026-11-11T10:00:00Z');
const commodity = (code, time = NOW, price = 100) => ({
  code,
  price,
  priceText: String(price),
  percent: 1,
  delta: 1,
  previousClose: 99,
  open: 99,
  high: 101,
  low: 98,
  timestamp: time / 1000,
  date: new Date(time + 8 * 3600000).toISOString().slice(0, 10),
  time: new Date(time + 8 * 3600000).toISOString().slice(11, 19)
});
const globalQuote = (id) => ({
  ...BUILTIN_INDICES.find((q) => q.id === id),
  price: 20000,
  percent: 1,
  delta: 200,
  previousClose: 19800,
  open: 19900,
  high: 20100,
  low: 19800,
  timestamp: Date.parse('2026-11-10T21:00:00Z') / 1000,
  source: 'eastmoney',
  timestampKind: 'quote'
});

test('美日韩按各自时区标注，纽约夏令时和日本午休不误判，上一交易时段不冒充盘前', () => {
  for (const time of ['2026-11-11T10:00:00Z', '2026-07-08T09:00:00Z'])
    assert.equal(regionalSessions(new Date(time)).find((s) => s.id === 'us').phase, 'pre');
  const midday = regionalSessions(new Date('2026-11-11T03:00:00Z'));
  assert.equal(midday.find((s) => s.id === 'jp').phase, 'break');
  assert.equal(midday.find((s) => s.id === 'kr').phase, 'regular');
  const cash = cashTiming('100.NDX', Date.parse('2026-11-10T21:00:00Z') / 1000, new Date(NOW));
  assert.equal(cash.currentReference, false);
  assert.equal(cash.quoteLocalTime, '2026-11-10 16:00');
  assert.match(cash.usage, /不代表当前盘前/);
  assert.equal(futureTiming(NOW / 1000, new Date(NOW), false).currentReference, true);
  assert.equal(futureTiming(NOW / 1000 - 600, new Date(NOW), false).currentReference, false);
  assert.equal(futureTiming(NOW / 1000, new Date(NOW), true).currentReference, false);
  assert.match(futureTiming(NOW / 1000 + 60, new Date(NOW), false).usage, /不能确认时效/);
});

test('每次外围查询更新期货，保留现货原时间；失败缓存不可标为当前信号', async () => {
  let now = NOW,
    fail = false,
    count = 0;
  const env = new AnalysisEnvironment({
    now: () => new Date(now),
    globalProvider: { load: async (ids) => ({ quotes: new Map(ids.map((id) => [id, globalQuote(id)])) }) },
    commodityProvider: {
      load: async (codes) => {
        count++;
        return {
          quotes: fail ? new Map() : new Map(codes.map((code) => [code, commodity(code, now, count + 100)])),
          errors: new Map()
        };
      }
    }
  });
  const one = await env.load('sh600519', undefined, undefined, ['global']);
  assert.equal(one.globalMarkets.futures.length, 2);
  assert.equal(one.globalMarkets.sessions.length, 3);
  assert.equal(one.globalMarkets.futures[0].currentReference, true);
  assert.equal(one.globalMarkets.quotes[0].currentReference, false);
  const old = one.globalMarkets.futures[0].timestamp;
  now += 1000;
  const two = await env.load('sh600519', undefined, undefined, ['global']);
  assert.equal(count, 2);
  assert.ok(two.globalMarkets.futures[0].timestamp > old);
  assert.equal(two.globalMarkets.quotes[0].timestamp, one.globalMarkets.quotes[0].timestamp);
  fail = true;
  now += 1000;
  const three = await env.load('sh600519', undefined, undefined, ['global']);
  assert.equal(three.globalMarkets.futures[0].fetchFailed, true);
  assert.equal(three.globalMarkets.futures[0].currentReference, false);
  assert.equal(three.globalMarkets.futures[0].timestamp, two.globalMarkets.futures[0].timestamp);
});

test('行情追问刷新美日韩外围，术语解释不刷新，失败标记不会把旧期货当新报价', async () => {
  let now = NOW,
    fail = false,
    count = 0;
  const source = {
    quoteProvider: {
      load: async (ids) => ({
        quotes: new Map(ids.map((symbol) => [symbol, { symbol, price: 10, timestamp: '20261111180000' }]))
      })
    },
    chartProvider: { load: async () => ({ bars: [] }) },
    environment: {
      load: async (_s, _sig, _name, parts) => {
        if (parts.includes('global')) {
          count++;
          if (fail) throw Error('offline');
          return {
            globalMarkets: {
              checkedAt: new Date(now).toISOString(),
              quotes: [globalQuote('100.NDX')],
              futures: [{ code: 'NQ', price: 100 + count, timestamp: now / 1000, currentReference: true }]
            }
          };
        }
        return { market: { amount: 10 }, sectors: { industry: '测试', rows: [] } };
      }
    }
  };
  const data = new AgentData(source, () => now),
    signal = new AbortController().signal;
  const previous = {
    capturedAt: new Date(NOW - 3600000).toISOString(),
    notes: [],
    quote: { price: 10 },
    timeframes: {},
    globalMarkets: { quotes: [], futures: [] }
  };
  const one = await data.prepare('sh600519', previous, '现在外围怎么样', signal);
  now += 1000;
  const two = await data.prepare('sh600519', one, '目前风险呢', signal);
  assert.equal(count, 2);
  assert.equal(two.globalMarkets.futures[0].price, 102);
  await data.prepare('sh600519', two, '解释一下MACD是什么意思', signal);
  assert.equal(count, 2);
  fail = true;
  now += 1000;
  const three = await data.prepare('sh600519', two, '现在呢', signal);
  assert.equal(three.globalMarkets.fetchFailed, true);
  assert.equal(three.globalMarkets.futures[0].currentReference, false);
  assert.equal(three.globalMarkets.futures[0].timestamp, two.globalMarkets.futures[0].timestamp);
});

test('旧画像迁移为单一全局档案，持仓独立存储；切股或修改本股成本不改变全局偏好', async () => {
  const h = harness();
  h.store.set('ai.profile.v1', {
    risk: 'conservative',
    horizon: 'long',
    goal: '控制回撤',
    initialized: true,
    updatedAt: '2026-11-11',
    observation: '仅分析茅台',
    holdings: { sh600519: { status: 'held', cost: 1500, exposure: 10, at: '2026-11-11', confirmed: true } }
  });
  const store = new ProfileStore(h.context.globalState);
  assert.equal(store.forAnalysis().observation, undefined);
  assert.equal(store.positionForAnalysis('sh600519').cost, 1500);
  const profile = store.forAnalysis();
  await store.editHolding({ status: 'held', cost: 50, exposure: 5 }, 'sz002475');
  assert.deepEqual(store.forAnalysis(), profile);
  assert.equal(h.store.get('ai.profile.v1').holdings, undefined);
  assert.equal(h.store.get('ai.positions.v1').sh600519.cost, 1500);
  assert.equal(new ProfileStore(h.context.globalState).positionForAnalysis('sz002475').cost, 50);
  await store.clear();
  assert.equal(store.positionForAnalysis('sh600519').cost, 1500);
  assert.equal(store.read().risk, 'unknown');
});

test('关注股票、板块、周期跨标的聚合进同一画像，无行业数据时不猜测归属', async () => {
  const h = harness(),
    interests = new InterestStore(
      h.context.globalState,
      () => true,
      () => NOW
    );
  interests.noteSector('sh600519', '白酒');
  interests.noteSector('sz002475', '消费电子');
  interests.record('sh600519', 'open');
  interests.record('sz002475', 'open');
  interests.record('sh600519', 'period', 'monthly');
  interests.record('sz002475', 'period', 'weekly');
  const global = interests.globalSummary(['sh600519', 'sz002475', 'sh601138']);
  assert.equal(global.stocks.length, 3);
  assert.equal(global.stocks[2].industry, '未知');
  assert.equal(global.periods.length, 2);
  assert.equal(global.currentSymbol, undefined);
  const store = new ProfileStore(h.context.globalState);
  await store.noteInterests(global);
  assert.equal(store.forAnalysis().interests.sectors.length, 2);
  assert.equal(store.forAnalysis(false).interests, undefined);
  await store.edit({ risk: 'balanced', horizon: 'mixed', goal: '关注科技产业' });
  assert.equal(store.forAnalysis().interests.stocks.length, 3);
  assert.equal(store.forAnalysis().scope, 'user');
  h.store.set('ai.profile.v1', { ...store.read(), interests: { scope: 'user', stocks: [null], sectors: [] } });
  const restored = new ProfileStore(h.context.globalState);
  assert.equal(restored.forAnalysis().interests, undefined);
  assert.equal(restored.read().goal, '关注科技产业');
});
