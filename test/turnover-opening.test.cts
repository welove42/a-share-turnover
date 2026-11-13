const test = require('node:test');
const assert = require('node:assert/strict');
const { MarketProvider } = require('../dist/features/turnover/provider');
const { turnoverSession, session, parseMarketQuote, isSnapshot } = require('../dist/features/turnover/market');
const { marketTemperature } = require('../dist/features/temperature/service');
const { SYMBOLS, quote, minutePayload, historyPayload } = require('./fixtures.cts');
const openingTime = new Date('2026-10-26T09:25:10+08:00');
const quotes = (stamp = '20261026092500', amounts = [123456789, 234567890]) =>
  SYMBOLS.map((symbol, i) => {
    const values = quote(symbol, amounts[i], stamp);
    values[37] = String(Math.round(amounts[i] / 10000));
    return `v_${symbol}="${values.join('~')}";`;
  }).join('\n');

test('成交额从09:25开始轮询，常规交易时段与温度仍从09:30开始', () => {
  for (const [time, polling, phase] of [
    ['09:24:59', false, 'before'],
    ['09:25:00', true, 'opening'],
    ['09:29:59', true, 'opening'],
    ['09:30:00', true, 'trading'],
    ['11:30:00', false, 'lunch'],
    ['13:00:00', true, 'trading'],
    ['15:00:00', true, 'settling'],
    ['15:02:00', false, 'after']
  ]) {
    const now = new Date(`2026-10-26T${time}+08:00`),
      clock = turnoverSession(now);
    assert.equal(clock.polling, polling, time);
    assert.equal(clock.phase, phase, time);
    if (time < '09:30:00') assert.equal(session(now).polling, false);
  }
  for (const date of ['2026-10-24', '2026-10-25', '2026-10-01'])
    assert.equal(turnoverSession(new Date(`${date}T09:25:00+08:00`)).polling, false);
  assert.equal(turnoverSession(openingTime, ['2026-10-26']).polling, false);
});

test('09:25只发一次批量报价请求，精确读取两市累计额，不等待分钟曲线或历史', async () => {
  const calls = [];
  const provider = new MarketProvider({
    now: () => openingTime,
    quoteRequest: async (url, signal) => {
      calls.push({ url, signal });
      return quotes();
    },
    request: async () => {
      throw new Error('盘前不应请求分时或历史');
    }
  });
  const controller = new AbortController();
  const snapshot = await provider.load(controller.signal, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://qt.gtimg.cn/q=${SYMBOLS.join(',')}`);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(snapshot.amount, 358024679, '使用元字段，不使用经过取整的万元');
  assert.equal(snapshot.date, '2026-10-26');
  assert.equal(snapshot.sameTime, null);
  assert.equal(snapshot.previousDay, null);
  assert.equal(snapshot.comparisonTime, null);
  assert.ok(snapshot.markets.every((market) => market.timestamp === '20261026092500'));
  assert.match(snapshot.warning, /开盘撮合.*暂不计算昨日同刻/);
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(marketTemperature(snapshot, {}, session(openingTime), openingTime).score, null);
});

test('实时报价失败时复用分时接口的最新报价，忽略昨日或尚未就绪的分钟曲线', async () => {
  const calls = [];
  const provider = new MarketProvider({
    now: () => openingTime,
    quoteRequest: async () => {
      throw new Error('HTTP 503');
    },
    request: async (url) => {
      calls.push(url);
      const symbol = new URL(url).searchParams.get('code');
      const payload = minutePayload(symbol, 123456789, '20261026092500');
      // 同一响应可包含今日实时 qt 与昨日分钟曲线；昨日曲线不能参与比较。
      payload.data[symbol].data =
        symbol === SYMBOLS[0] ? { date: '20261023', data: ['1500 3000 2000 999999999'] } : null;
      return payload;
    }
  });
  const snapshot = await provider.load();
  assert.equal(snapshot.amount, 246913578);
  assert.equal(snapshot.sameTime, null);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.includes('/minute/')));
});

test('旧日期、撮合前报价、未来报价或缺少一市时不能冒充今日两市开盘成交额', async () => {
  const broken = [
    quotes('20261023092500'),
    quotes('20261026092459'),
    quotes('20261026092600'),
    quotes().split('\n')[0],
    quotes().replace(/v_sh000002=/, 'v_sh000001='),
    quotes().replace('3000/10000/123456789', '3000/10000/-1')
  ];
  for (const text of broken) {
    const provider = new MarketProvider({
      now: () => openingTime,
      quoteRequest: async () => text,
      request: async (url) => {
        const symbol = new URL(url).searchParams.get('code');
        return minutePayload(symbol, 999999999, '20261023150000');
      }
    });
    await assert.rejects(provider.load(), /等待两市更新今日09:25/);
  }
  assert.throws(() => parseMarketQuote(quote(SYMBOLS[1], 1), SYMBOLS[0]), /实时行情字段异常/);
});

test('正常零成交额可显示，取消时不启动备用、不返回快照', async () => {
  let calls = 0;
  const controller = new AbortController();
  const provider = new MarketProvider({
    now: () => openingTime,
    quoteRequest: async () => {
      calls++;
      return quotes('20261026092500', [0, 0]);
    },
    request: async () => {
      throw new Error('不应请求备用');
    }
  });
  assert.equal((await provider.load()).amount, 0);
  controller.abort();
  await assert.rejects(provider.load(controller.signal), /已取消/);
  assert.equal(calls, 1);
  const pending = new AbortController();
  provider.quoteRequest = async () => {
    pending.abort();
    return quotes();
  };
  await assert.rejects(provider.load(pending.signal), /已取消/);
});

test('09:30自动回到分钟行情和历史基准，同刻比较正常恢复', async () => {
  let now = openingTime,
    quoteCalls = 0;
  const calls = [];
  const provider = new MarketProvider({
    now: () => now,
    quoteRequest: async () => {
      quoteCalls++;
      return quotes();
    },
    request: async (url) => {
      calls.push(url);
      const symbol = new URL(url).searchParams.get('code');
      return url.includes('/minute/')
        ? minutePayload(symbol, 2e8, '20261026093010', ['0930 3000 100 200000000'])
        : historyPayload(symbol);
    }
  });
  assert.equal((await provider.load()).sameTime, null);
  now = new Date('2026-10-26T09:30:10+08:00');
  const snapshot = await provider.load();
  assert.equal(quoteCalls, 1);
  assert.equal(calls.length, 4);
  assert.equal(snapshot.comparisonTime, '09:30');
  assert.equal(snapshot.sameTime.percent, 100);
  assert.ok(snapshot.previousDay);
  assert.equal(snapshot.warning, '');
});
