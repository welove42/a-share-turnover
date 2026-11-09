const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  summarizeChart,
  summarizeIntraday,
  forming,
  comparableReturns,
  analysisPayload
} = require('../dist/features/ai/technical-context.js');
const { AnalysisContext } = require('../dist/features/ai/context.js');
const { AiHistoryProvider } = require('../dist/features/ai/history-data.js');
const { SYSTEM } = require('../dist/features/ai/prompt.js');
const NOW = new Date('2026-11-09T06:00:00Z');
function history(mode = 'daily', count = 240, up = true) {
  const dates = [];
  let d = new Date('2026-11-09T00:00:00Z');
  if (mode === 'weekly') d = new Date('2026-11-13T00:00:00Z');
  if (mode === 'monthly') d = new Date('2026-11-01T00:00:00Z');
  while (dates.length < count) {
    if (mode !== 'daily' || ![0, 6].includes(d.getUTCDay())) dates.unshift(d.toISOString().slice(0, 10));
    if (mode === 'monthly') d.setUTCMonth(d.getUTCMonth() - 1);
    else d.setUTCDate(d.getUTCDate() - (mode === 'weekly' ? 7 : 1));
  }
  return {
    source: '测试行情',
    adjustment: '前复权',
    timestamp: '20261109140000',
    date: dates.at(-1),
    bars: dates.map((time, i) => {
      const price = up ? 100 + i : 500 - i;
      return { time, open: price, high: price + 2, low: price - 1, close: price + 1, volume: 100 };
    })
  };
}
function minutes(date, volumes = [100, 200, 300], times = ['0930', '0931', '0932']) {
  return volumes.map((volume, i) => ({
    date,
    time: times[i],
    open: 10 + i,
    close: 10 + i,
    high: 10 + i,
    low: 10 + i,
    volume,
    averagePrice: 10 + i / 2
  }));
}
test('日周月独立计算并裁剪样本；未完成日K从确认指标、收益和量比中排除', () => {
  const raw = history();
  raw.bars.at(-1).volume = 999999;
  const d = summarizeChart(raw, 'daily', NOW);
  assert.equal(d.sample.used, 240);
  assert.equal(d.sample.closed, 239);
  assert.equal(d.forming, true);
  assert.equal(d.confirmedThrough, '2026-11-06');
  assert.equal(d.indicators.MA5, 337);
  assert.equal(d.volume.ratioToPrior20, 1);
  assert.equal(d.volume.date, '2026-11-06');
  assert.equal(d.developing.volume, 999999);
  assert.equal(d.returns.length, 3);
  assert.equal(d.returns[0].to, '2026-11-06');
  assert.equal(d.state, '偏强');
  assert.equal(d.ranges.prior20.count, 20);
  assert.equal(d.bars.length, 3);
  assert.equal(summarizeChart(history('weekly', 240, false), 'weekly', NOW).sample.used, 120);
  assert.equal(summarizeChart(history('monthly', 100), 'monthly', NOW).sample.used, 60);
});
test('周线偏弱与日线偏强独立保留，不能用当日反弹覆盖中期；样本不足不输出成熟指标', () => {
  const weekly = summarizeChart(history('weekly', 120, false), 'weekly', NOW);
  const daily = summarizeChart(history(), 'daily', NOW);
  assert.equal(weekly.state, '偏弱');
  assert.equal(daily.state, '偏强');
  assert.equal(weekly.forming, true);
  const short = summarizeChart(history('daily', 8), 'daily', NOW);
  assert.equal(short.state, '样本不足');
  assert.equal(short.indicators.MA20, null);
  assert.equal(short.indicators.macd, undefined);
  assert.equal(short.volume.ratioToPrior20, null);
});
test('收盘确认需同日收盘报价；周月到下一周期才当完整，异常序列不静默删点', () => {
  const close = new Date('2026-11-09T07:01:00Z');
  assert.equal(forming('2026-11-09', 'daily', close, '20261109150000'), false);
  assert.equal(forming('2026-11-09', 'daily', close, '20261109145900'), true);
  assert.equal(forming('2026-11-09', 'daily', close), true);
  assert.equal(forming('2026-11-13', 'weekly', NOW), true);
  assert.equal(forming('2026-11-01', 'monthly', NOW), true);
  for (const mutate of [
    (c) => (c.bars[5].volume = NaN),
    (c) => (c.bars[5].time = c.bars[4].time),
    (c) => (c.bars[5].time = '2026-02-30'),
    (c) => (c.bars.at(-1).time = '2026-11-10')
  ]) {
    const c = history();
    mutate(c);
    assert.equal(summarizeChart(c, 'daily', NOW), null);
  }
});
test('分时使用真实均价、极值与同一分钟累计量，不插值或拿部分日量比全天', () => {
  const chart = {
    source: '测试',
    adjustment: '不复权',
    bars: [
      ...minutes('2026-11-05', [10, 20, 30]),
      ...minutes('2026-11-06', [30, 30], ['0930', '0933']),
      ...minutes('2026-11-09')
    ]
  };
  const s = summarizeIntraday(chart, NOW);
  assert.equal(s.sameTimeVolume.current, 600);
  assert.equal(s.sameTimeVolume.ratioToPreviousMean, 10);
  assert.deepEqual(s.sameTimeVolume.previousDays, [{ date: '2026-11-05', volume: 60 }]);
  assert.deepEqual(s.high, { price: 12, time: '0932' });
  assert.equal(s.averagePrice, 11);
  assert.equal(s.days.length, 3);
  assert.ok(s.points.length <= 7);
  assert.equal(s.historical, false);
  chart.bars.forEach((b) => (b.averagePrice = null));
  assert.equal(summarizeIntraday(chart, NOW).averagePrice, null);
  assert.equal(summarizeIntraday({ bars: minutes('2026-11-06') }, NOW).historical, true);
});
test('历史相对强弱严格匹配起止日，负复权基数不生成收益；发送时去重且旧快照兼容', () => {
  const a = [{ bars: 5, from: '2026-11-01', to: '2026-11-06', percent: 5 }];
  assert.deepEqual(comparableReturns(a, [{ ...a[0], percent: 2 }]), [
    { bars: 5, from: '2026-11-01', to: '2026-11-06', difference: 3 }
  ]);
  assert.deepEqual(comparableReturns(a, [{ ...a[0], from: '2026-10-31' }]), []);
  const snap = { daily: { date: '2026-11-06' }, coverage: [], notes: [] };
  assert.ok(analysisPayload(snap).daily);
  assert.equal(analysisPayload({ ...snap, timeframes: { daily: snap.daily } }).daily, undefined);
  assert.equal(analysisPayload(snap).coverage, undefined);
  const c = history();
  c.bars.forEach((b) => Object.assign(b, { open: -10, close: -9, high: -8, low: -11 }));
  assert.deepEqual(summarizeChart(c, 'daily', NOW).returns, []);
});
function context(options = {}) {
  const calls = [];
  return {
    calls,
    c: new AnalysisContext({
      now: () => NOW,
      chartProvider: {
        load: async (code, mode) => {
          calls.push(code + ':' + mode);
          return mode.startsWith('intraday')
            ? {
                source: '测试分时',
                adjustment: '不复权',
                date: '2026-11-09',
                bars:
                  mode === 'intraday'
                    ? minutes('2026-11-09')
                    : [...minutes('2026-11-06'), ...minutes('2026-11-09', [50, 100], ['0930', '0931'])]
              }
            : history(mode);
        }
      },
      quoteProvider: {
        load: async (codes) => ({
          quotes: new Map(
            codes.map((symbol) => [symbol, { symbol, price: 340, percent: 1, timestamp: '20261109140000' }])
          )
        })
      },
      environment: {
        load: async () => ({
          market: { amount: 123 },
          sectors: { industry: '行业', rows: [{ name: '行业', code: 'BK0477', timestamp: 1794204000 }] },
          globalMarkets: { quotes: [{ id: '100.NDX', name: '纳指' }] },
          news: { items: [] }
        })
      },
      historyProvider: { load: async () => ({ ...history(), cached: false, fetchedAt: NOW.toISOString() }) },
      ...options
    })
  };
}
test('完整采集各周期、更新较旧五日分时，基准请求去重，加入行业/全球历史且主进程不泄露私有字段', async () => {
  const { c, calls } = context();
  const data = await c.collect('sh000001');
  assert.equal(calls.filter((v) => v === 'sh000001:daily').length, 1);
  assert.equal(data.timeframes.intraday.time, '0932');
  assert.equal(data.timeframes.intraday.days.length, 2);
  assert.equal(data.timeframes.intraday.sameTimeVolume.ratioToPreviousMean, 1);
  assert.equal(data.timeframes.monthly.sample.used, 60);
  assert.equal(data.timeframes.weekly.sample.used, 120);
  assert.equal(data.market.history.length, 4);
  assert.equal(data.sectors.history.returns.length, 3);
  assert.equal(data.globalMarkets.history[0].returns[0].to, '2026-11-06');
  assert.ok(JSON.stringify(analysisPayload(data)).length < 24000);
  const market = await c.collect('market');
  assert.ok(market.market.history.every((h) => h.timeframes.daily && h.timeframes.weekly && h.timeframes.monthly));
  assert.match(SYSTEM, /月线.*周线.*日线.*分时/);
  assert.ok(SYSTEM.length < 1200);
});
test('月周数据缺失保留其他行情；辅助历史失败保留原环境，ETF不猜跟踪指数', async () => {
  const { c } = context({
    chartProvider: {
      load: async (_s, mode) => {
        if (mode !== 'daily') throw Error('不可用');
        return { ...history(), etf: { price: 1, iopv: 0.99, premiumRate: 1.01, quoteTimestamp: '20261109140000' } };
      }
    },
    historyProvider: {
      load: async () => {
        throw Error('不可用');
      }
    }
  });
  const d = await c.collect('sh510300');
  assert.ok(d.timeframes.daily);
  assert.equal(d.timeframes.weekly, undefined);
  assert.match(d.notes.join(''), /周线缺失/);
  assert.equal(d.market.amount, 123);
  assert.equal(d.sectors.history.missing, true);
  assert.equal(d.etf.premiumRate, 1.01);
  assert.match(d.etf.trackingIndex, /未取得/);
});
test('取消分析会终止并发数据收集，不能在取消后继续调用AI', async () => {
  const abort = new AbortController();
  let started = 0;
  const { c } = context({
    chartProvider: {
      load: async () => {
        started++;
        return new Promise(() => {});
      }
    }
  });
  const result = c.collect('sh600519', abort.signal);
  await new Promise((r) => setImmediate(r));
  abort.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.ok(started > 0);
});
test('行业历史验证标的和OHLC、正确缓存原时间；取消不能返回缓存', async () => {
  let now = NOW.getTime(),
    fail = false,
    count = 0;
  const h = new AiHistoryProvider(
    async (url) => {
      count++;
      assert.match(url, /secid=90\.BK0477/);
      if (fail) throw Error('断网');
      return { rc: 0, data: { code: 'BK0477', klines: ['2026-11-06,10,11,12,9,100'] } };
    },
    () => now
  );
  const first = await h.load('90.BK0477');
  assert.equal(first.cached, false);
  await h.load('90.BK0477');
  assert.equal(count, 1);
  now += 11 * 60000;
  fail = true;
  const old = await h.load('90.BK0477');
  assert.equal(old.cached, true);
  assert.equal(old.fetchedAt, first.fetchedAt);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.load('90.BK0477', controller.signal), { name: 'AbortError' });
});
test('历史接口不接受错误标的、非法数值或错序日线，失败不缓存', async () => {
  for (const payload of [
    { rc: 0, data: { code: 'BK0001', klines: ['2026-11-06,10,11,12,9,100'] } },
    { rc: 0, data: { code: 'BK0477', klines: ['2026-11-06,10,11,8,9,100'] } },
    { rc: 0, data: { code: 'BK0477', klines: ['2026-11-06,10,,12,9,100'] } },
    { rc: 0, data: { code: 'BK0477', klines: ['2026-11-06,10,11,12,9,100', '2026-11-05,10,11,12,9,100'] } }
  ]) {
    let count = 0;
    const h = new AiHistoryProvider(
      async () => {
        count++;
        return payload;
      },
      () => NOW.getTime()
    );
    await assert.rejects(h.load('90.BK0477'));
    await assert.rejects(h.load('90.BK0477'));
    assert.equal(count, 2);
  }
});
