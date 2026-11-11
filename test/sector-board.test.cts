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
const query = (overrides = {}) => ({view:'table',page:1,sort:'percent',direction:'gainers',search:'',...overrides});
test('列表仅请求当前30条，云图单独请求成交额前50条，失败切换节点', async () => {
  const urls = [];
  const provider = new SectorBoardProvider(
    async (url) => {
      urls.push(url);
      if (new URL(url).hostname === 'push2.eastmoney.com') throw new Error('HTTP 501');
      const n = Number(new URL(url).searchParams.get('pz'));
      return page(101, Array.from({ length: n }, (_, i) => entry(i)));
    },
    () => now,
    0
  );
  const value = await provider.load('industry', new AbortController().signal, query({page: 2}));
  assert.equal(value.total, 101);
  assert.equal(value.rows.length, 30);
  assert.equal(value.rows[0].amount, 100000);
  assert.equal(value.rows[0].volume, 100);
  assert.equal(value.rows[0].leaderPercent, 8.3);
  assert.equal(urls.length, 2);
  assert.equal(urls.filter((u) => new URL(u).hostname === 'push2.eastmoney.com').length, 1);
  assert.match(urls[1], /pz=30/);
  assert.match(urls[1], /pn=2/);
  await provider.load('industry', new AbortController().signal, query({view:'heatmap'}));
  assert.match(urls[2], /pz=50/);
  assert.match(urls[2], /fid=f6/);
  await provider.load('industry', new AbortController().signal, query({view:'heatmap',mapSort:'percent'}));
  assert.equal(new URL(urls[3]).searchParams.get('fid'), 'f3');
  assert.equal(new URL(urls[3]).searchParams.get('po'), '1');
  await provider.load('industry', new AbortController().signal, query({view:'heatmap',mapSort:'percent',direction:'losers'}));
  assert.equal(new URL(urls[4]).searchParams.get('fid'), 'f3');
  assert.equal(new URL(urls[4]).searchParams.get('po'), '0');
  assert.equal(new URL(urls[4]).searchParams.get('pz'), '50');
  const noFields = parseBoardPage(page(1, [{ ...entry(1), f6: '-', f5: '-', f124: '-', f128: '-' }]), 'concept', now)
    .rows[0];
  assert.equal(noFields.amount, null);
  assert.equal(noFields.volume, null);
  assert.equal(noFields.timestamp, null);
  assert.throws(() => parseBoardPage(page(1, [entry(1)]), 'wrong', now));
});
test('异常空分页和取消不能作为成功结果', async () => {
  const p = new SectorBoardProvider(
    async () => page(101, []),
    () => now,
    0
  );
  await assert.rejects(p.load('concept', new AbortController().signal, query()), /为空/);
  await assert.rejects(p.load('industry', AbortSignal.abort(), query()), /取消/);
  const x = parseBoardPage(page(2, [entry(1), { ...entry(2), f3: '-' }]), 'industry', now);
  assert.equal(x.total, 2);
  assert.equal(x.rows.length, 1);
});
test('搜索只获取候选板块的有限行情，空结果不查询行情', async () => {
  const urls = [];
  const provider = new SectorBoardProvider(async (url) => {
    urls.push(url);
    if (url.includes('/suggest/')) return { QuotationCodeTable: { Status: 0, Data: [{Classify:'BK',Code:'BK1000'}, {Classify:'AStock',Code:'600000'}, {Classify:'BK',Code:'BK1000'}] } };
    return page(1, [entry(0)]);
  }, () => now);
  const result = await provider.load('industry', new AbortController().signal, query({search:'测试'}));
  assert.equal(result.rows.length, 1);
  assert.match(urls[1], /secids=90%2EBK1000|secids=90.BK1000/);
  assert.doesNotMatch(urls[1], /600000/);
  const empty = new SectorBoardProvider(async () => ({QuotationCodeTable:{Status:0,Data:null}}), () => now);
  assert.equal((await empty.load('industry', new AbortController().signal, query({search:'无结果'}))).total, 0);
});
test('切换页码取消旧请求，迟到数据不能覆盖当前页', async () => {
  const h = harness(), { SectorsController } = h.load('../dist/features/sectors/controller');
  const c = new SectorsController(h.context, { now: () => new Date(now), provider: { load: async () => [] } });
  const pending = [];
  c.board.provider = { load: (category, signal, request) => new Promise((resolve, reject) => {
    pending.push({ request, resolve, reject, signal });
    signal.addEventListener('abort', () => reject(new Error('取消')), {once:true});
  }) };
  try {
    c.board.open();
    const p = h.panels[0], token = c.board.token;
    p.webview.receive.fire({token,action:'ready'});
    await tick();
    assert.equal(pending[0].request.page, 1);
    await c.board.receive({token,action:'query',value:{view:'table',page:2,sort:'percent',search:''}});
    await tick(); await tick();
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(pending[1].request.page, 2);
    pending[1].resolve({category:'industry',rows:[],total:60,fetchedAt:now,source:'测试'});
    await c.board.inflight;
    assert.equal(p.webview.messages.at(-1).query.page, 2);
  } finally { c.dispose(); }
});
test('状态栏打开复用页面，切换分类与方向，页面隐藏及老板键终止请求', async () => {
  const h = harness(),
    { SectorsController } = h.load('../dist/features/sectors/controller');
  let calls = 0;
  const requests = [];
  const c = new SectorsController(h.context, { now: () => new Date(now), provider: { load: async () => Array.from({length:10},(_,i)=>({code:`BK${1000+i}`,name:`测试${i}`,percent:10-i,timestamp:Math.floor(now/1000)})) } });
  c.board.provider = {
    load: async (category, signal, request) => {
      calls++;
      requests.push(request);
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
    const messageCount = p.webview.messages.length;
    await c.board.receive({token,action:'query',value:{view:'table',page:1,sort:'percent',search:''}});
    assert.equal(calls, 1);
    assert.ok(p.webview.messages.length > messageCount);
    assert.equal(p.webview.messages.at(-1).type, 'state');
    await c.board.receive({ token, action: 'category', value: 'concept' });
    await tick();
    await c.board.inflight;
    assert.equal(c.category, 'concept');
    assert.equal(calls, 2);
    await c.board.receive({ token, action: 'direction', value: 'losers' });
    await tick();
    assert.equal(c.direction, 'losers');
    assert.equal(calls, 3);
    await c.board.receive({token,action:'query',value:{view:'heatmap',page:1,sort:'percent',search:''}});
    await c.board.inflight;
    assert.equal(calls, 4);
    await c.board.receive({token,action:'direction',value:'gainers'});
    await tick();
    assert.equal(calls, 4, '云图只按成交额取数据，切换涨跌榜不重复获取');
    await c.board.receive({token,action:'query',value:{view:'heatmap',page:1,sort:'percent',search:'',mapSort:'percent'}});
    await c.board.inflight;
    assert.equal(calls, 5);
    assert.equal(requests.at(-1).mapSort, 'percent');
    assert.equal(requests.at(-1).direction, 'gainers');
    await c.board.receive({token,action:'direction',value:'losers'});
    await tick();
    await c.board.inflight;
    assert.equal(calls, 6);
    assert.equal(requests.at(-1).direction, 'losers');
    await c.board.receive({token,action:'query',value:{view:'heatmap',page:1,sort:'percent',search:'',mapSort:'amount'}});
    assert.equal(calls, 6, '切回成交额复用已有云图缓存');
    c.setHidden(true);
    assert.equal(p.disposed, true);
    assert.equal(c.board.panel, undefined);
  } finally {
    c.dispose();
  }
});
