const test = require('node:test');
const assert = require('node:assert/strict');
const { SinaBoardProvider, parseSinaBoard } = require('../dist/features/sectors/sina-board');
const { SectorBoardProvider } = require('../dist/features/sectors/board-data');
const { harness } = require('./vscode-mock.cts');
const now = Date.parse('2026-11-12T02:00:00Z');
const query = (values = {}) => ({
  view: 'table',
  page: 1,
  sort: 'percent',
  direction: 'gainers',
  search: '',
  mapSort: 'amount',
  ...values
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function summary(category = 'industry', count = 65) {
  const entries = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const code = `${category === 'industry' ? 'new_' : 'gn_'}test${index}`;
      return [
        code,
        `${code},测试板块${index},10,20,1,${index - 30},${(index + 1) * 10000},${(index + 1) * 1000000},sh600001,${index / 10},10,1,领涨股${index}`
      ];
    })
  );
  return `var S_Finance_bankuai_${category === 'industry' ? 'sinaindustry' : 'class'} = ${JSON.stringify(entries)};`;
}

test('新浪盘口字段正确映射，成交量从股换算为手，不伪造行情时间和缺失字段', () => {
  const text =
    'var S_Finance_bankuai_sinaindustry = {"new_blhy":"new_blhy,玻璃行业,19,14.785789473684,0.30631578947368,2.1155174293919,497785365,7402524805,sz002623,9.987,25.660,2.330,亚玛顿"};';
  const row = parseSinaBoard(text, 'industry')[0];
  assert.equal(row.name, '玻璃行业');
  assert.equal(row.percent, 2.1155174293919);
  assert.equal(row.volume, 4977853.65);
  assert.equal(row.amount, 7402524805);
  assert.equal(row.leader, '亚玛顿');
  assert.equal(row.leaderPercent, 9.987);
  for (const field of ['timestamp', 'turnover', 'marketCap', 'up', 'down']) assert.equal(row[field], null);
  assert.throws(() => parseSinaBoard(text, 'concept'), /类型/);
  assert.throws(() => parseSinaBoard(text + 'globalThis.bad = true;', 'industry'), /格式/);
  assert.throws(() => parseSinaBoard('var S_Finance_bankuai_class = {};', 'concept'), /数量/);
  assert.throws(
    () =>
      parseSinaBoard(
        'var S_Finance_bankuai_class = {"gn_test":"gn_test,测试,1,1,1,-,10,20,sh600001,1,1,1,测试"};',
        'concept'
      ),
    /有效板块/
  );
});

test('主源断连后自动切换新浪，分页、成交额和涨跌云图共用60秒汇总，不混板块口径', async () => {
  let clock = now,
    primaryCalls = 0,
    backupCalls = 0,
    restored = false;
  const backup = new SinaBoardProvider(
    async () => {
      backupCalls++;
      return summary();
    },
    () => clock
  );
  const provider = new SectorBoardProvider(
    async () => {
      primaryCalls++;
      if (!restored) throw new Error('socket hang up');
      return { rc: 0, data: { total: 1, diff: [{ f12: 'BK1000', f14: '东方板块', f3: 1 }] } };
    },
    () => clock,
    3500,
    backup
  );
  const first = await provider.load('industry', new AbortController().signal, query());
  assert.equal(primaryCalls, 3);
  assert.equal(backupCalls, 1);
  assert.equal(first.total, 65);
  assert.equal(first.rows.length, 30);
  assert.equal(first.rows[0].percent, 34);
  assert.equal(first.sourceId, 'sina');
  assert.match(first.notice, /分类及数量不同/);
  assert.ok(first.rows.every((row) => row.code.startsWith('new_')));
  const second = await provider.load('industry', new AbortController().signal, query({ page: 2 }));
  assert.equal(second.rows[0].percent, 4);
  const losers = await provider.load(
    'industry',
    new AbortController().signal,
    query({ view: 'heatmap', mapSort: 'losers' })
  );
  assert.equal(losers.rows.length, 30);
  assert.equal(losers.rows[0].percent, -30);
  assert.ok(losers.rows.every((row) => row.percent < 0));
  const amounts = await provider.load('industry', new AbortController().signal, query({ view: 'heatmap' }));
  assert.equal(amounts.rows.length, 50);
  assert.equal(amounts.rows[0].amount, 65000000);
  assert.equal(primaryCalls, 3);
  assert.equal(backupCalls, 1);
  clock += 61000;
  restored = true;
  const primary = await provider.load('industry', new AbortController().signal, query());
  assert.equal(primary.source, '东方财富');
  assert.equal(primary.rows[0].code, 'BK1000');
  assert.equal(primary.notice, undefined);
  assert.equal(backupCalls, 1);
});

test('新浪不足50个板块时按云图依据筛选，涨幅不混入下跌，保持来源总数', async () => {
  let calls = 0;
  const provider = new SinaBoardProvider(async () => {
    calls++;
    return summary('industry', 49);
  }, () => now);
  const load = (mapSort) => provider.load('industry', new AbortController().signal, query({ view: 'heatmap', mapSort }));
  const amounts = await load('amount'), gainers = await load('gainers'), losers = await load('losers');
  assert.equal(amounts.rows.length, 49);
  assert.equal(gainers.rows.length, 18);
  assert.equal(gainers.rows[0].percent, 18);
  assert.ok(gainers.rows.every((row) => row.percent > 0));
  assert.equal(losers.rows.length, 30);
  assert.equal(losers.rows[0].percent, -30);
  assert.ok(losers.rows.every((row) => row.percent < 0));
  assert.ok([amounts, gainers, losers].every((data) => data.total === 49));
  assert.equal(calls, 1, '切换依据复用汇总，不重复查询新浪');
  const table = await provider.load('industry', new AbortController().signal, query({ direction: 'losers', page: 2 }));
  assert.equal(table.rows.length, 19, '列表保留全部板块，按原方式分页');
  assert.equal(table.rows[0].percent, 0);
});

test('主源拖住时仍给独立备用源保留时间，而不是等完整轮次超时', async () => {
  let primarySignal;
  const backup = new SinaBoardProvider(
    async () => summary(),
    () => now
  );
  const provider = new SectorBoardProvider(
    (_url, signal) => {
      primarySignal = signal;
      return new Promise(() => {});
    },
    () => now,
    1000,
    backup
  );
  provider.primaryTimeoutMs = 15;
  const result = await provider.load('industry', new AbortController().signal, query());
  assert.equal(primarySignal.aborted, true);
  assert.equal(result.sourceId, 'sina');
});

test('主源返回空榜或损坏行情时启用备用，真实的空搜索结果不触发备用', async () => {
  let calls = 0;
  const backup = new SinaBoardProvider(
    async () => {
      calls++;
      return summary();
    },
    () => now
  );
  for (const response of [
    { rc: 0, data: { total: 0, diff: [] } },
    { rc: 0, data: { total: 1, diff: [{ f12: 'BK1000', f14: '损坏板块', f3: '-' }] } }
  ]) {
    const provider = new SectorBoardProvider(
      async () => response,
      () => now,
      3500,
      backup
    );
    assert.equal((await provider.load('industry', new AbortController().signal, query())).sourceId, 'sina');
  }
  const provider = new SectorBoardProvider(
    async () => ({
      QuotationCodeTable: { Status: 0, Data: null }
    }),
    () => now,
    3500,
    backup
  );
  const result = await provider.load('industry', new AbortController().signal, query({ search: '不存在的板块' }));
  assert.equal(result.source, '东方财富');
  assert.equal(result.total, 0);
  assert.equal(calls, 1);
});

test('新浪概念支持名称和代码搜索、成交量排序与末页，空结果不虚构数据', async () => {
  let calls = 0;
  const provider = new SinaBoardProvider(
    async () => {
      calls++;
      return summary('concept');
    },
    () => now
  );
  const found = await provider.load('concept', new AbortController().signal, query({ search: '板块1' }));
  assert.equal(found.total, 11);
  assert.equal(found.rows.length, 11);
  assert.ok(found.rows.every((row) => row.name.includes('板块1')));
  const code = await provider.load('concept', new AbortController().signal, query({ search: 'gn_test64' }));
  assert.equal(code.rows[0].code, 'gn_test64');
  const last = await provider.load('concept', new AbortController().signal, query({ page: 3, sort: 'volume' }));
  assert.equal(last.rows.length, 5);
  assert.equal(last.rows[0].volume, 500);
  const empty = await provider.load('concept', new AbortController().signal, query({ search: 'BK1000' }));
  assert.equal(empty.total, 0);
  assert.equal(calls, 1);
});

test('新浪快照本机恢复；更新失败保留原时间，冷却不重复查询，过期快照不冒充新数据', async () => {
  let clock = now,
    calls = 0;
  const store = new Map();
  const storage = {
    get: (key, fallback) => store.get(key) || fallback,
    update: async (key, value) => {
      store.set(key, value);
    }
  };
  const initial = new SinaBoardProvider(
    async () => summary(),
    () => clock
  );
  initial.attach(storage);
  await initial.load('industry', new AbortController().signal, query());
  await tick();
  const restored = new SinaBoardProvider(
    async () => {
      calls++;
      throw new Error('备用源断连');
    },
    () => clock
  );
  restored.attach(storage);
  assert.equal((await restored.load('industry', new AbortController().signal, query())).fetchedAt, now);
  assert.equal(calls, 0);
  clock += 61000;
  const stale = await restored.load('industry', new AbortController().signal, query());
  assert.equal(stale.fetchedAt, now);
  assert.equal(stale.stale, true);
  assert.match(stale.notice, /更新失败/);
  await restored.load('industry', new AbortController().signal, query({ view: 'heatmap' }));
  assert.equal(calls, 1);
  clock += 86400000;
  await assert.rejects(restored.load('industry', new AbortController().signal, query()), /断连/);
});

test('用户取消主源后不启动新浪请求，取消新浪时也不污染快照', async () => {
  let backupCalls = 0;
  const backup = new SinaBoardProvider(
    async () => {
      backupCalls++;
      return summary();
    },
    () => now
  );
  const provider = new SectorBoardProvider(
    () => new Promise(() => {}),
    () => now,
    1000,
    backup
  );
  const controller = new AbortController();
  const pending = provider.load('industry', controller.signal, query());
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(backupCalls, 0);
  const delayed = new SinaBoardProvider(
    () => new Promise(() => {}),
    () => now,
    1000
  );
  const cancelled = new AbortController();
  const request = delayed.load('concept', cancelled.signal, query());
  cancelled.abort();
  await assert.rejects(request, /取消/);
  assert.equal(delayed.cache.size, 0);
  assert.equal(delayed.failed.size, 0);
});

test('页面发送新浪来源、缺失字段提示和缓存状态，恢复主源时清除旧提示', async () => {
  const mock = harness();
  const { SectorsController } = mock.load('../dist/features/sectors/controller');
  let clock = now,
    fail = false;
  const owner = new SectorsController(mock.context, { now: () => new Date(clock), provider: { load: async () => [] } });
  owner.board.provider = {
    load: async () => ({
      category: 'industry',
      rows: [],
      total: 0,
      fetchedAt: now,
      source: fail ? '新浪财经（备用）' : '东方财富',
      notice: fail ? '使用新浪快照' : undefined,
      stale: fail
    })
  };
  try {
    owner.board.open();
    mock.panels[0].webview.receive.fire({ token: owner.board.token, action: 'ready' });
    await owner.board.inflight;
    fail = true;
    clock += 61000;
    owner.board.update();
    await owner.board.inflight;
    const message = mock.panels[0].webview.messages.at(-1);
    assert.equal(message.stale, true);
    assert.equal(message.data.notice, '使用新浪快照');
    fail = false;
    clock += 61000;
    owner.board.update();
    await owner.board.inflight;
    assert.equal(mock.panels[0].webview.messages.at(-1).data.notice, undefined);
  } finally {
    owner.dispose();
  }
});
