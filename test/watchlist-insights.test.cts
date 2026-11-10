const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  quoteVolume,
  listMetrics,
  volumeProgress,
  WatchlistHistoryProvider
} = require('../dist/features/watchlist/insights-data');
const { parseQuotes } = require('../dist/features/watchlist/quotes');
const { harness } = require('./vscode-mock.cts');
const dates = [
  '2026-10-12',
  '2026-10-13',
  '2026-10-14',
  '2026-10-15',
  '2026-10-16',
  '2026-10-19',
  '2026-10-20',
  '2026-10-21',
  '2026-10-22',
  '2026-10-23'
];
const history = () => ({
  bars: dates.map((date, i) => ({ date, close: 10 + i, volume: 1000 })),
  source: '腾讯前复权日线',
  unit: '手'
});
function quote(symbol = 'sh600519', volume = 1500, timestamp = '20261026150000') {
  const q = Array(62).fill('');
  q[1] = '测试股';
  q[2] = symbol.slice(2);
  q[3] = '20';
  q[4] = '19';
  q[6] = String(volume);
  q[30] = timestamp;
  q[31] = '1';
  q[32] = '5.26';
  q[33] = '21';
  q[34] = '18';
  return parseQuotes(`v_${symbol}="${q.join('~')}";`, [symbol]).quotes.get(symbol);
}
const flush = () => new Promise((r) => setImmediate(r));

test('普通A股与科创板成交量统一为手，空字段不能当0', () => {
  assert.equal(quoteVolume('sh600519', '1500'), 1500);
  assert.equal(quoteVolume('sh688981', '150000'), 1500);
  assert.equal(quoteVolume('hk00700', '150000'), 150000);
  assert.equal(quoteVolume('usAAPL', '150000'), 150000);
  assert.equal(quoteVolume('sh600519', ''), null);
  assert.equal(quoteVolume('sh600519', '-1'), null);
  assert.equal(quote('sh688981', 150000).volume, 1500);
});

test('七日均量只取报价日前7个完整交易日，排除当天未完成K线', () => {
  const h = history();
  h.bars.push({ date: '2026-10-26', close: 20, volume: 999999 });
  const m = listMetrics(quote(), h, 'a');
  assert.equal(m.average, 1000);
  assert.equal(m.previous.length, 7);
  assert.equal(m.previous[0].date, '2026-10-15');
  assert.equal(m.previous.at(-1).date, '2026-10-23');
  assert.equal(m.ratio, 1.5);
  assert.equal(m.label, '放量');
  assert.equal(m.estimated, false);
  assert.equal(m.trend.label, '短线偏强');
  for (const [volume, label] of [
    [1200, '平量'],
    [1201, '放量'],
    [800, '平量'],
    [799, '缩量']
  ])
    assert.equal(listMetrics(quote('sh600519', volume), h, 'a').label, label);
});

test('盘中明确为进度预估，午休不增长交易分钟，开盘15分钟前不判断缩量', () => {
  const m = listMetrics(quote('sh600519', 600, '20261026110000'), history(), 'a');
  assert.equal(m.actualRatio, 0.6);
  assert.ok(Math.abs(m.ratio - 1.6) < 1e-9);
  assert.equal(m.estimated, true);
  assert.equal(m.label, '放量');
  assert.equal(volumeProgress('20261026113000', 'a').elapsed, 120);
  assert.equal(volumeProgress('20261026123000', 'a').elapsed, 120);
  assert.equal(volumeProgress('20261026130000', 'hk').elapsed, 150);
  assert.equal(volumeProgress('20261026160000', 'hk').total, 330);
  const early = listMetrics(quote('sh600519', 100, '20261026093500'), history(), 'a');
  assert.equal(early.ratio, null);
  assert.equal(early.actualRatio, 0.1);
  assert.equal(listMetrics(quote('sh600519', 100, '20261026130000'), history(), 'us').ratio, null);
});

test('样本不足、零均量、停牌及过旧历史不生成误导标签', () => {
  const h = history();
  h.bars = h.bars.slice(-6);
  let m = listMetrics(quote(), h, 'a');
  assert.equal(m.average, null);
  assert.equal(m.label, undefined);
  assert.equal(m.trend, undefined);
  h.bars = history().bars.map((b) => ({ ...b, volume: 0 }));
  m = listMetrics(quote(), h, 'a');
  assert.equal(m.ratio, null);
  assert.match(listMetrics(quote('sh600519', 0), history(), 'a').missing, /暂无有效成交/);
  h.bars = history().bars.map((b) => ({ ...b, date: b.date.replace('2026', '2011') }));
  assert.match(listMetrics(quote(), h, 'a').missing, /历史/);
  h.bars = history().bars.map((b, i) => ({ ...b, close: 30 - i }));
  assert.equal(listMetrics({ ...quote(), price: 19 }, h, 'a').trend.label, '短线偏弱');
});

test('历史适配器校验标的和日期、统一单位，美股使用近期复权数据', async () => {
  const a = new WatchlistHistoryProvider(async () => ({
    code: 0,
    data: { sh688981: { qfqday: [['2026-10-23', '10', '11', '12', '9', '100000']] } }
  }));
  assert.equal((await a.load('sh688981', new AbortController().signal)).bars[0].volume, 1000);
  const us = new WatchlistHistoryProvider(async (url) => {
    assert.match(url, /BRK-B/);
    return {
      chart: {
        result: [
          {
            meta: { symbol: 'BRK-B' },
            timestamp: [Date.parse('2026-10-23T13:30:00Z') / 1000],
            indicators: { quote: [{ close: [10], volume: [900] }], adjclose: [{ adjclose: [9.9] }] }
          }
        ]
      }
    };
  });
  const r = await us.load('usBRK.B', new AbortController().signal);
  assert.equal(r.bars[0].close, 9.9);
  assert.equal(r.bars[0].date, '2026-10-23');
  assert.equal(r.unit, '股');
  await assert.rejects(a.load('https://example.com', new AbortController().signal));
});

function fixture(settings = {}, load = async () => history()) {
  const h = harness({ 'aShareTurnover.stocks.symbols': ['sh600519'], ...settings });
  let time = Date.parse('2026-10-26T07:10:00Z'),
    calls = 0;
  const { WatchlistController } = h.load('../dist/features/watchlist/controller');
  const create = () => {
    const c = new WatchlistController(h.context, {
      now: () => new Date(time),
      provider: { load: async () => ({ quotes: new Map(), errors: new Map() }) },
      insightsProvider: {
        load: async (...args) => {
          calls++;
          return load(...args);
        }
      }
    });
    c.quotes.set('sh600519', quote());
    c.cached = false;
    c.tree.visible = true;
    return c;
  };
  const c = create();
  return {
    h,
    c,
    create,
    count: () => calls,
    advance: (n) => (time += n),
    row: () => c.getTreeItem(c.element('sh600519'))
  };
}

test('只附加行尾与悬停，标签/图标/命令/分组及异动标记保持不变', async () => {
  const f = fixture();
  const before = f.row();
  await flush();
  const after = f.row();
  assert.equal(after.label, before.label);
  assert.deepEqual(after.iconPath, before.iconPath);
  assert.equal(after.contextValue, before.contextValue);
  assert.equal(after.id, before.id);
  assert.deepEqual(after.command, before.command);
  assert.match(after.description, /短线偏强.*放量 1.50×/);
  assert.match(after.tooltip.value, /前7个完整交易日均量/);
  f.c.activity.record(quote(), 'a', '涨停炸板');
  const marked = f.row();
  assert.match(marked.description, /涨停炸板.*短线偏强/);
  assert.ok(marked.label.highlights.length);
  assert.equal(f.c.getParent(f.c.element('sh600519')), f.c.group);
  assert.equal(f.count(), 1);
  f.c.dispose();
});

test('关闭两项或侧栏不可见不查询，打开后懒加载；当日及重启复用缓存', async () => {
  const off = fixture({ 'aShareTurnover.stocks.trendDisplay': 'off', 'aShareTurnover.stocks.volumeComparison': false });
  assert.equal(off.row().description, '');
  await flush();
  assert.equal(off.count(), 0);
  off.c.dispose();
  const f = fixture();
  f.c.tree.visible = false;
  f.row();
  await flush();
  assert.equal(f.count(), 0);
  f.c.tree.visible = true;
  f.row();
  await flush();
  f.row();
  await flush();
  assert.equal(f.count(), 1);
  const restarted = f.create();
  restarted.getTreeItem(restarted.element('sh600519'));
  await flush();
  assert.equal(f.count(), 1);
  assert.ok(f.h.store.get('stockListHistoryV1').length);
  assert.ok(!f.h.context.syncedKeys?.includes('stockListHistoryV1'));
  restarted.dispose();
  f.c.dispose();
});

test('老板键及暂停取消后台历史请求，迟到结果不落入缓存', async () => {
  for (const mode of ['hidden', 'paused']) {
    let resolve, signal;
    const f = fixture({}, async (s, a) => {
      signal = a;
      return new Promise((r) => (resolve = r));
    });
    f.row();
    if (mode === 'hidden') f.c.setHidden(true);
    else {
      f.c.paused = true;
      f.c.publish();
    }
    assert.equal(signal.aborted, true);
    resolve(history());
    await flush();
    assert.equal(f.h.store.has('stockListHistoryV1'), false);
    f.c.dispose();
  }
});

test('失败冷却、不改变正常报价；交易日变化重新获取历史', async () => {
  let fail = true;
  const f = fixture({}, async () => {
    if (fail) throw new Error('offline');
    return history();
  });
  f.row();
  await flush();
  assert.equal(f.count(), 1);
  assert.equal(f.c.errors.size, 0);
  assert.match(f.row().tooltip.value, /历史指标暂不可用/);
  await flush();
  assert.equal(f.count(), 1);
  f.advance(31 * 60000);
  fail = false;
  f.row();
  await flush();
  assert.equal(f.count(), 2);
  f.advance(86400000);
  f.c.quotes.set('sh600519', quote('sh600519', 1200, '20261027150000'));
  f.row();
  await flush();
  assert.equal(f.count(), 3);
  f.c.dispose();
});

test('并发最多两只，移除个股后不会应用旧请求结果', async () => {
  const pending = new Map();
  const f = fixture(
    { 'aShareTurnover.stocks.symbols': ['sh600519', 'sz000001', 'sh601318'] },
    (s, signal) => new Promise((r) => pending.set(s, { resolve: r, signal }))
  );
  for (const s of f.c.config.symbols) {
    f.c.quotes.set(s, quote(s));
    f.c.getTreeItem(f.c.element(s));
  }
  assert.equal(f.count(), 2);
  assert.equal(pending.size, 2);
  f.c.config.symbols = ['sz000001', 'sh601318'];
  f.c.insights.reconcile();
  assert.equal(pending.get('sh600519').signal.aborted, true);
  pending.get('sh600519').resolve(history());
  await flush();
  assert.equal(f.count(), 3);
  pending.get('sz000001').resolve(history());
  pending.get('sh601318').resolve(history());
  await flush();
  assert.ok(f.h.store.get('stockListHistoryV1').every((e) => e.symbol !== 'sh600519'));
  f.c.dispose();
});

test('美股盘前盘后保持原显示，不混入常规趋势和成交量', async () => {
  const f = fixture({ 'aShareTurnover.stocks.usSymbols': ['usAAPL'] });
  const item = new f.h.api.TreeItem('美股');
  item.description = '盘前';
  item.tooltip = new f.h.api.MarkdownString();
  f.c.insights.decorate(item, { ...quote(), symbol: 'usAAPL' }, 'us', false, false);
  assert.equal(item.description, '盘前');
  assert.match(item.tooltip.value, /盘前\/盘后不混算/);
  assert.equal(f.count(), 0);
  f.c.dispose();
});

test('设置可分别关闭趋势和量能，立即生效且不触发原报价刷新', async () => {
  const f = fixture();
  f.row();
  await flush();
  let refreshes = 0;
  f.c.provider.load = async () => {
    refreshes++;
    return { quotes: new Map(), errors: new Map() };
  };
  await f.c.updateSetting('stocks.trendDisplay', 'off');
  assert.doesNotMatch(f.row().description, /短线/);
  assert.match(f.row().description, /放量/);
  await f.c.updateSetting('stocks.volumeComparison', false);
  assert.equal(f.row().description, '');
  assert.equal(refreshes, 0);
  assert.equal(f.c.settings.get('stocks.trendDisplay', 'text'), 'off');
  f.c.dispose();
});
