const test = require('node:test'),
  assert = require('node:assert/strict');
const { AgentData, explanationOnly, applyEvidence } = require('../dist/features/ai/agent-data.js');
const { AnalysisEnvironment } = require('../dist/features/ai/environment.js');
const { snapshotText } = require('../dist/features/ai/agent-context.js');
test('更新个股或大盘报价后不沿用旧相对强弱，比较其他股票不覆盖当前快照', () => {
  const snapshot = { quote: { price: 10 }, relativeStrength: { difference: 2 }, timeframes: {} };
  const updated = applyEvidence(snapshot, 'sh600519', [{ tool: 'get_quote', args: {}, data: { price: 11 } }]);
  assert.equal(updated.quote.price, 11);
  assert.equal(updated.relativeStrength, undefined);
  const market = applyEvidence(snapshot, 'sh600519', [
    { tool: 'get_market', args: {}, data: { market: { percent: 1 } } }
  ]);
  assert.equal(market.relativeStrength, undefined);
  const other = applyEvidence(snapshot, 'sh600519', [
    { tool: 'get_quote', args: { symbol: 'sz000001' }, data: { price: 12 } }
  ]);
  assert.deepEqual(other.quote, snapshot.quote);
  assert.deepEqual(other.relativeStrength, snapshot.relativeStrength);
});
function fixture() {
  let now = Date.parse('2026-11-10T02:00:00Z'),
    price = 10,
    fail = false;
  const calls = [],
    signal = new AbortController().signal;
  const source = {
    quoteProvider: {
      load: async (symbols) => {
        calls.push('quote');
        if (fail) throw new Error('offline');
        return {
          quotes: new Map(
            symbols.map((symbol) => [
              symbol,
              {
                symbol,
                price,
                date: '2026-11-10',
                timestamp: new Date(now + 8 * 3600000).toISOString().slice(0, 19).replace(/[-T:]/g, ''),
                source: '测试行情'
              }
            ])
          )
        };
      }
    },
    chartProvider: {
      load: async (_symbol, period) => {
        calls.push(period);
        if (fail) throw new Error('offline');
        return {
          source: '测试行情',
          date: '2026-11-10',
          adjustment: '前复权',
          bars: Array.from({ length: 80 }, (_, i) => ({
            time: period.startsWith('intraday')
              ? `2026-11-10 ${String(9 + Math.floor((30 + i) / 60)).padStart(2, '0')}:${String((30 + i) % 60).padStart(2, '0')}`
              : new Date(Date.UTC(2026, 7, 20 + i)).toISOString().slice(0, 10),
            open: 10,
            close: 10 + i * 0.01,
            high: 12,
            low: 9,
            volume: 100
          }))
        };
      }
    },
    environment: {
      load: async (_symbol, _signal, _name, sections) => {
        calls.push(...sections);
        return {
          market: { amount: 100, fetchedAt: new Date(now).toISOString() },
          sectors: { industry: '测试', rows: [] },
          news: { items: [{ title: '公开消息', publishedAt: new Date(now).toISOString() }], source: '测试快讯' }
        };
      }
    },
    collect: async () => {
      calls.push('all');
      return {
        target: 'sh600519',
        capturedAt: new Date(now).toISOString(),
        notes: [],
        quote: { price: 10 },
        timeframes: { weekly: { state: '偏弱', date: '2026-11-06' } }
      };
    }
  };
  return {
    source,
    data: new AgentData(source, () => now),
    calls,
    signal,
    advance: (ms) => (now += ms),
    price: (v) => (price = v),
    fail: () => (fail = true)
  };
}

test('上午分析后下午追问自动更新报价/分时/大盘，旧周线保持原时间', async () => {
  const f = fixture(),
    first = await f.data.prepare('sh600519', null, undefined, f.signal);
  f.advance(3 * 3600000);
  f.price(12);
  const next = await f.data.prepare('sh600519', first, '现在怎么样？', f.signal);
  assert.equal(next.quote.price, 12);
  assert.equal(next.quote.timestamp, '20261110130000');
  assert.notEqual(next.capturedAt, first.capturedAt);
  assert.equal(next.timeframes.weekly.date, first.timeframes.weekly.date);
  assert.equal(next.timeframes.weekly.fetchedAt, first.capturedAt);
  assert.ok(f.calls.includes('market'));
  assert.ok(f.calls.includes('intraday'));
  assert.equal(next.market.benchmarks.length, 4);
  assert.equal(next.market.benchmarks[0].timestamp, '20261110130000');
  assert.equal(next.relativeStrength, undefined);
});

test('追问洗盘出货主动补查日线，最近K线进入模型上下文，清除旧的日线缺失提示', async () => {
  const f = fixture(),
    first = await f.data.prepare('sh600519', null, undefined, f.signal);
  first.notes = ['日线缺失，不推断该周期走势。'];
  const next = await f.data.prepare('sh600519', first, '分析一下最近的日线走势，是洗盘还是出货', f.signal);
  assert.ok(f.calls.includes('daily'));
  assert.equal(next.timeframes.daily.recentBars.length, 10);
  assert.ok(!next.notes.some((n) => n.startsWith('日线缺失')));
  const sent = JSON.parse(snapshotText(next));
  assert.equal(sent.timeframes.daily.recentBars.length, 10);
  assert.equal(sent.timeframes.daily.recentBarsOrder, '新到旧');
  assert.equal(sent.timeframes.daily.recentBars[0].time, next.timeframes.daily.recentBars[0].time);
  assert.ok(Number.isFinite(sent.timeframes.daily.recentBars[0].volume));
});

test('解释近期日线走势仍补查；只解释术语时不补查', async () => {
  const f = fixture(),
    first = await f.data.prepare('sh600519', null, undefined, f.signal);
  await f.data.prepare('sh600519', first, '解释一下洗盘是什么意思', f.signal);
  assert.deepEqual(f.calls, ['all']);
  await f.data.prepare('sh600519', first, '解释一下最近的日线走势', f.signal);
  assert.ok(f.calls.includes('daily'));
});

test('明确提及多个周期时逐一补查，失败保留旧日线和原时间并标明失败', async () => {
  const f = fixture(),
    first = await f.data.prepare('sh600519', null, undefined, f.signal);
  first.timeframes.daily = { date: '2026-11-09', state: '整理', fetchedAt: first.capturedAt };
  f.fail();
  f.advance(3600000);
  const next = await f.data.prepare('sh600519', first, '看看日线和周线走势', f.signal);
  assert.ok(f.calls.includes('daily'));
  assert.ok(f.calls.includes('weekly'));
  assert.equal(next.timeframes.daily.date, '2026-11-09');
  assert.equal(next.timeframes.daily.fetchedAt, first.capturedAt);
  assert.equal(next.timeframes.daily.fetchFailed, true);
  assert.equal(next.timeframes.weekly.fetchFailed, true);
});

test('术语解释不查数据，模糊追问默认检查行情，续写原样保留快照', async () => {
  const f = fixture(),
    first = await f.data.prepare('sh600519', null, undefined, f.signal);
  for (const question of ['这个背离是什么意思？', '继续', '解释一下刚才那句话']) {
    assert.equal(await f.data.prepare('sh600519', first, question, f.signal), first);
  }
  assert.deepEqual(f.calls, ['all']);
  assert.equal(explanationOnly('现在背离是什么意思？'), false);
  await f.data.prepare('sh600519', first, '有什么风险？', f.signal);
  assert.ok(f.calls.includes('quote'));
});

test('报价20秒内复用，过期刷新；失败回退保留原数据时间，不伪装刷新成功', async () => {
  const f = fixture();
  const one = await f.data.execute('get_quote', {}, 'sh600519', f.signal);
  f.advance(10000);
  const two = await f.data.execute('get_quote', {}, 'sh600519', f.signal);
  assert.equal(two.cached, true);
  assert.equal(two.fetchedAt, one.fetchedAt);
  assert.deepEqual(f.calls, ['quote']);
  f.advance(15000);
  f.price(11);
  const three = await f.data.execute('get_quote', {}, 'sh600519', f.signal);
  assert.equal(three.price, 11);
  f.advance(25000);
  f.fail();
  const failed = await f.data.execute('get_quote', {}, 'sh600519', f.signal);
  assert.equal(failed.fetchFailed, true);
  assert.equal(failed.fetchedAt, three.fetchedAt);
  assert.equal(failed.timestamp, three.timestamp);
});

test('工具参数白名单、数量限制和取消阻止额外网络请求', async () => {
  const f = fixture();
  for (const [name, args] of [
    ['get_quote', { symbol: 'https://attacker' }],
    ['get_quote', { url: 'https://attacker' }],
    ['shell', {}],
    ['get_technical', { bars: 10000 }],
    ['get_technical', { period: 'unknown' }],
    ['get_environment', { scope: 'all' }],
    ['get_news', { query: 'x'.repeat(81) }]
  ])
    await assert.rejects(f.data.execute(name, args, 'sh600519', f.signal));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.data.execute('get_quote', {}, 'sh600519', abort.signal), { name: 'AbortError' });
  assert.deepEqual(f.calls, []);
});

test('仅查周线不调用分时和新闻，返回原始K线最多30根并保留复权和时间', async () => {
  const f = fixture();
  const result = await f.data.execute('get_technical', { period: 'daily', bars: 30 }, 'sh600519', f.signal);
  assert.equal(result.bars.length, 30);
  assert.equal(result.summary.adjustment, '前复权');
  assert.deepEqual(f.calls, ['daily']);
  const compact = JSON.parse(
    snapshotText({ target: 'sh600519', capturedAt: result.fetchedAt, notes: [], timeframes: { daily: result.summary } })
  );
  assert.ok(compact.timeframes.daily.state);
  assert.ok(compact.timeframes.daily.date);
  assert.equal(compact.timeframes.daily.omitted, undefined);
});

test('新闻数据源按需读取，不能顺便请求全球/板块/大盘所有接口', async () => {
  const calls = [];
  const unavailable = (name) => ({
    load: async () => {
      calls.push(name);
      throw new Error('unexpected ' + name);
    }
  });
  const now = Date.parse('2026-11-10T02:00:00Z');
  const environment = new AnalysisEnvironment({
    now: () => new Date(now),
    marketProvider: unavailable('market'),
    globalProvider: unavailable('global'),
    commodityProvider: unavailable('commodities'),
    sectorProvider: unavailable('sector'),
    newsProvider: {
      load: async () => {
        calls.push('news');
        return [];
      }
    }
  });
  await environment.load('sh600519', undefined, '茅台', ['news']);
  assert.deepEqual(calls, ['news']);
});
