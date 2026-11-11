const test = require('node:test'),
  assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const { parseBoardPage, SectorBoardProvider } = require('../dist/features/sectors/board-data');
const tick = () => new Promise((r) => setImmediate(r));
const now = Date.parse('2026-11-10T02:30:00Z');
const entry = (i) => ({
  f12: `BK${String(1000 + i)}`,
  f14: `板块${i}`,
  f3: i - 50,
  f5: 100 + i,
  f6: 100000 + i,
  f8: 2.5,
  f20: 1000000,
  f104: 5,
  f105: 3,
  f124: Math.floor(now / 1000),
  f128: '领涨',
  f136: 8.3
});
function page(total, rows) {
  return { rc: 0, data: { total, diff: rows } };
}
test('完整板块分页保留真实行情与缺失字段，失败切换节点且冷却', async () => {
  const urls = [];
  const provider = new SectorBoardProvider(
    async (url) => {
      urls.push(url);
      if (new URL(url).hostname === 'push2.eastmoney.com') throw new Error('HTTP 501');
      const n = Number(new URL(url).searchParams.get('pn'));
      return page(101, n === 1 ? Array.from({ length: 100 }, (_, i) => entry(i)) : [entry(100)]);
    },
    () => now,
    0
  );
  const value = await provider.load('industry', new AbortController().signal);
  assert.equal(value.total, 101);
  assert.equal(value.rows.length, 101);
  assert.equal(value.rows[0].amount, 100000);
  assert.equal(value.rows[0].volume, 100);
  assert.equal(value.rows[0].leaderPercent, 8.3);
  assert.equal(urls.length, 3);
  assert.equal(urls.filter((u) => new URL(u).hostname === 'push2.eastmoney.com').length, 1);
  assert.match(urls[1], /pz=100/);
  const noFields = parseBoardPage(page(1, [{ ...entry(1), f6: '-', f5: '-', f124: '-', f128: '-' }]), 'concept', now)
    .rows[0];
  assert.equal(noFields.amount, null);
  assert.equal(noFields.volume, null);
  assert.equal(noFields.timestamp, null);
  assert.throws(() => parseBoardPage(page(1, [entry(1)]), 'wrong', now));
});
test('重复或无效行不冒充有效行情，空分页或取消不能作为成功结果', async () => {
  const p = new SectorBoardProvider(
    async (url) => (new URL(url).searchParams.get('pn') === '1' ? page(101, Array(100).fill(entry(1))) : page(101, [])),
    () => now,
    0
  );
  await assert.rejects(p.load('concept', new AbortController().signal), /不完整/);
  await assert.rejects(p.load('industry', AbortSignal.abort()), /取消/);
  const x = parseBoardPage(page(2, [entry(1), { ...entry(2), f3: '-' }]), 'industry', now);
  assert.equal(x.total, 2);
  assert.equal(x.rows.length, 1);
});
test('状态栏打开复用页面，切换分类与方向，页面隐藏及老板键终止请求', async () => {
  const h = harness(),
    { SectorsController } = h.load('../dist/features/sectors/controller');
  let calls = 0;
  const c = new SectorsController(h.context, { now: () => new Date(now), provider: { load: async () => Array.from({length:10},(_,i)=>({code:`BK${1000+i}`,name:`测试${i}`,percent:10-i,timestamp:Math.floor(now/1000)})) } });
  c.board.provider = {
    load: async (category, signal) => {
      calls++;
      return {
        category,
        total: 1,
        rows: [
          {
            code: 'BK1000',
            name: '测试',
            percent: 1,
            amount: 100,
            volume: 10,
            turnover: 2,
            marketCap: 1000,
            up: 1,
            down: 0,
            leader: '个股',
            leaderPercent: 5,
            timestamp: Math.floor(now / 1000)
          }
        ],
        fetchedAt: now,
        source: '东方财富'
      };
    }
  };
  try {
    assert.equal(c.item.command, 'welove42.aShareTurnover.sectors.open');
    c.board.open();
    c.board.open();
    assert.equal(h.panels.length, 1);
    assert.equal(h.panels[0].revealCalls, 1);
    const p = h.panels[0],
      token = c.board.token;
    assert.match(p.webview.html, /Content-Security-Policy/);
    assert.match(p.webview.html, /sector-board.js/);
    p.webview.receive.fire({ token: 'wrong', action: 'ready' });
    await tick();
    assert.equal(calls, 0);
    p.webview.receive.fire({ token, action: 'ready' });
    await c.board.inflight;
    assert.equal(calls, 1);
    assert.equal(p.webview.messages.at(-1).data.rows[0].name, '测试');
    c.board.update();
    c.board.update(true);
    assert.equal(calls, 1);
    await c.board.receive({ token, action: 'category', value: 'concept' });
    await tick();
    await c.board.inflight;
    assert.equal(c.category, 'concept');
    assert.equal(calls, 2);
    await c.board.receive({ token, action: 'direction', value: 'losers' });
    await tick();
    assert.equal(c.direction, 'losers');
    assert.equal(calls, 2);
    c.setHidden(true);
    assert.equal(p.disposed, true);
    assert.equal(c.board.panel, undefined);
  } finally {
    c.dispose();
  }
});
