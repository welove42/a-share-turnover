const test = require('node:test');
const assert = require('node:assert/strict');
const { KlineFeed, getKlineFeed } = require('../dist/features/charts/kline-feed');
const { ChartProvider } = require('../dist/features/charts/data');
const { WatchlistHistoryProvider } = require('../dist/features/watchlist/insights-data');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = '2026-11-09,10,11,12,9,100,105000,30,10,1,0.5';
function em(url, rows = [row]) {
  const [market, code] = new URL(url).searchParams.get('secid').split('.');
  return { rc: 0, data: { market: Number(market), code, name: '测试', klines: rows } };
}
function qq(symbol = 'sh600519', rows = [['2026-11-09', 10, 11, 12, 9, 100]]) {
  return { code: 0, data: { [symbol]: { qfqday: rows } } };
}
const blocked = () => Object.assign(new Error('数据接口 HTTP 501'), { statusCode: 501 });
const storage = () => {
  const values = new Map();
  return {
    values,
    get: (k, f) => values.get(k) ?? f,
    update: async (k, v) => {
      values.set(k, structuredClone(v));
    }
  };
};

test('独立源保持日周月和分钟周期，转换科创板单位并保留换手率、成交额', async () => {
  for (const [mode, time, klt] of [
    ['daily', '2026-11-09', 101],
    ['weekly', '2026-11-09', 102],
    ['monthly', '2026-11-09', 103],
    ['m1', '2026-11-09 09:31', 1],
    ['m5', '2026-11-09 09:35', 5],
    ['m15', '2026-11-09 09:45', 15],
    ['m30', '2026-11-09 10:00', 30],
    ['m60', '2026-11-09 10:30', 60]
  ]) {
    const p = new ChartProvider(async (url) => {
      assert.equal(new URL(url).searchParams.get('klt'), String(klt));
      return em(url, [row.replace('2026-11-09', time)]);
    });
    const data = await p.load('sh688836', mode);
    assert.equal(data.bars[0].volume, 100);
    assert.equal(data.bars[0].historicalTurnover, 0.5);
    assert.equal(data.bars[0].amount, 105000);
    assert.equal(data.bars[0].time, time);
    assert.equal(data.sourceId, klt > 100 ? 'eastmoney:qfq' : 'eastmoney:raw');
  }
});

test('图表、AI与列表同请求合并；列表只取40天，缓存副本互不污染', async () => {
  let calls = 0,
    release;
  const rows = Array.from({ length: 60 }, (_, i) =>
    row.replace('2026-11-09', new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10))
  );
  const request = async (url) => {
    calls++;
    await new Promise((r) => (release = r));
    return em(url, rows);
  };
  const chart = new ChartProvider(request),
    ai = new ChartProvider(request, 1),
    list = new WatchlistHistoryProvider(request);
  const pending = [
    chart.load('sh600519', 'daily'),
    ai.load('sh600519', 'daily'),
    list.load('sh600519', new AbortController().signal)
  ];
  await tick();
  assert.equal(calls, 1);
  release();
  const [a, b, c] = await Promise.all(pending);
  assert.equal(c.bars.length, 40);
  assert.equal(a.bars.length, 60);
  a.bars[0].close = 999;
  assert.equal(b.bars[0].close, 11);
  assert.equal((await chart.load('sh600519', 'daily')).bars[0].close, 11);
  assert.equal(calls, 1);
  getKlineFeed(request).dispose();
});

test('主源失败自动切换，501冷却在不同标的间共享', async () => {
  const calls = [];
  const feed = new KlineFeed(
    async (url) => {
      calls.push(url);
      if (url.includes('eastmoney')) throw blocked();
      const symbol = new URL(url).searchParams.get('param').split(',')[0];
      return qq(symbol);
    },
    () => 1000000,
    0
  );
  try {
    assert.equal((await feed.load('sh600519', 'daily')).sourceId, 'tencent:qfq');
    assert.equal((await feed.load('sz000001', 'daily')).sourceId, 'tencent:qfq');
    assert.equal(calls.filter((u) => u.includes('eastmoney')).length, 1);
  } finally {
    feed.dispose();
  }
});

test('原接口501后普通股票使用搜狐不复权，ETF不误用股票专用备用源', async () => {
  const urls = [];
  const feed = new KlineFeed(
    async (url) => {
      urls.push(url);
      if (!url.includes('sohu')) throw blocked();
      return [
        { status: 0, code: 'cn_600519', hq: [['2026-11-09', '10', '11', '1', '10%', '9', '12', '100', '10.5', '0.5%']] }
      ];
    },
    () => 1000000,
    0
  );
  try {
    const r = await feed.load('sh600519', 'daily');
    assert.equal(r.sourceId, 'sohu:raw');
    assert.equal(r.payload.data.sh600519.day[0][10], '0.5');
    await assert.rejects(feed.load('sh563530', 'daily'), /暂不可用/);
    assert.equal(urls.length, 3);
  } finally {
    feed.dispose();
  }
});

test('历史分页锁定来源和复权；单个代码错误不会封锁全数据源', async () => {
  const urls = [];
  const feed = new KlineFeed(
    async (url) => {
      urls.push(url);
      if (url.includes('gtimg')) return { code: 0, data: { sh600519: { day: [['2026-11-09', 10, 11, 12, 9, 100]] } } };
      if (url.includes('1.600519')) return em(url, []);
      return em(url);
    },
    () => 1000000,
    0
  );
  try {
    await assert.rejects(
      feed.load('sh600519', 'daily', undefined, { end: '2026-11-09', sourceId: 'tencent:qfq' }),
      /复权/
    );
    assert.equal(urls.length, 1);
    const empty = await feed.load('sh600519', 'daily', undefined, { end: '2026-11-09', sourceId: 'eastmoney:qfq' });
    assert.equal(empty.payload.data.sh600519.qfqday.length, 0);
    assert.equal((await feed.load('sz000001', 'daily')).sourceId, 'eastmoney:qfq');
  } finally {
    feed.dispose();
  }
});

test('单个订阅者取消不影响其他使用者；全部取消则不缓存、不触发来源冷却', async () => {
  let calls = 0,
    release,
    upstream;
  const feed = new KlineFeed(
    async (url, signal) => {
      calls++;
      upstream = signal;
      await new Promise((r) => (release = r));
      return em(url);
    },
    () => 1000000,
    0
  );
  try {
    const abort = new AbortController();
    const a = feed.load('sh600519', 'daily', abort.signal),
      b = feed.load('sh600519', 'daily');
    const rejected = assert.rejects(a, { name: 'AbortError' });
    await tick();
    abort.abort();
    await rejected;
    assert.equal(upstream.aborted, false);
    release();
    await b;
    assert.equal(calls, 1);
    const all = new AbortController();
    const c = feed.load('sz000001', 'daily', all.signal);
    const cRejected = assert.rejects(c, { name: 'AbortError' });
    await tick();
    all.abort();
    await cRejected;
    assert.equal(upstream.aborted, true);
    release();
    await tick();
    const retry = feed.load('sz000001', 'daily');
    await tick();
    release();
    assert.equal((await retry).sourceId, 'eastmoney:qfq');
    assert.equal(calls, 3);
  } finally {
    feed.dispose();
  }
});

test('前台排在后台之前，最多两路并发，连续启动遵守间隔', async () => {
  const started = [],
    pending = [];
  let active = 0,
    max = 0;
  const feed = new KlineFeed(
    async (url) => {
      started.push({ symbol: new URL(url).searchParams.get('secid'), at: Date.now() });
      max = Math.max(max, ++active);
      await new Promise((r) => pending.push(r));
      active--;
      return em(url);
    },
    Date.now,
    20
  );
  try {
    const promises = [
      feed.load('sh600519', 'daily', undefined, { priority: 2 }),
      feed.load('sz000001', 'daily', undefined, { priority: 2 }),
      feed.load('sh600105', 'daily', undefined, { priority: 0 })
    ];
    await new Promise((r) => setTimeout(r, 55));
    assert.equal(started.length, 2);
    assert.equal(started[1].symbol, '1.600105');
    pending.splice(0).forEach((r) => r());
    await new Promise((r) => setTimeout(r, 35));
    pending.splice(0).forEach((r) => r());
    await Promise.all(promises);
    assert.equal(max, 2);
    assert.ok(started[1].at - started[0].at >= 18);
    assert.equal(started[2].symbol, '0.000001');
  } finally {
    feed.dispose();
  }
});

test('失败回退保留原缓存时间；持久化恢复后仍受统一冷却约束', async () => {
  let now = Date.parse('2026-11-10T02:00:00Z'),
    fail = false,
    calls = 0;
  const store = storage();
  const request = async (url) => {
    calls++;
    if (fail) throw blocked();
    return em(url);
  };
  const feed = new KlineFeed(request, () => now, 0);
  feed.attach(store);
  const first = await feed.load('sh563530', 'daily');
  now += 300001;
  fail = true;
  const old = await feed.load('sh563530', 'daily');
  assert.equal(old.stale, true);
  assert.equal(old.fetchedAt, first.fetchedAt);
  assert.equal(calls, 3);
  await feed.load('sh563530', 'daily');
  assert.equal(calls, 3);
  feed.dispose();
  await tick();
  const restored = new KlineFeed(request, () => now, 0);
  restored.attach(store);
  try {
    const again = await restored.load('sh563530', 'daily');
    assert.equal(again.stale, true);
    assert.equal(again.fetchedAt, first.fetchedAt);
    assert.equal(calls, 3);
    now += 7 * 86400000;
    await assert.rejects(restored.load('sh563530', 'daily'), /暂不可用/);
  } finally {
    restored.dispose();
  }
});

test('新交易日不复用前一天刚采集的历史；坏分钟时间和错误标的不进入缓存', async () => {
  let now = Date.parse('2026-11-09T15:59:59Z'),
    calls = 0;
  const feed = new KlineFeed(
    async (url) => {
      calls++;
      return em(url);
    },
    () => now,
    0
  );
  try {
    await feed.load('sh600519', 'daily');
    now += 2000;
    await feed.load('sh600519', 'daily');
    assert.equal(calls, 2);
  } finally {
    feed.dispose();
  }
  for (const mutate of [
    (p) => (p.data.code = '000001'),
    (p) => (p.data.klines = [row.replace('2026-11-09', '2026-11-09 29:00')])
  ]) {
    const bad = new KlineFeed(
      async (url) => {
        const p = em(url);
        mutate(p);
        return p;
      },
      () => now,
      0
    );
    try {
      await assert.rejects(bad.load('sh600519', 'm5', undefined, { sourceId: 'eastmoney:raw' }));
      assert.equal(bad.cache.size, 0);
    } finally {
      bad.dispose();
    }
  }
});
