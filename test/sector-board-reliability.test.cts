const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./vscode-mock.cts');
const { SectorBoardProvider } = require('../dist/features/sectors/board-data');
const now = Date.parse('2026-11-12T02:00:00Z');
const query = { view: 'table', page: 1, sort: 'percent', direction: 'gainers', search: '' };
const payload = {
  rc: 0,
  data: { total: 1, diff: [{ f12: 'BK1000', f14: '测试板块', f3: 1, f6: 1000 }] }
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function board(provider) {
  const mock = harness();
  const { SectorsController } = mock.load('../dist/features/sectors/controller');
  const owner = new SectorsController(mock.context, {
    now: () => new Date(now),
    provider: { load: async () => [] }
  });
  owner.board.provider = provider;
  owner.board.open();
  const panel = mock.panels[0];
  panel.webview.receive.fire({ token: owner.board.token, action: 'ready' });
  return { owner, panel, board: owner.board, token: owner.board.token };
}

test('失败冷却期间重新查询仍显示失败原因，不能退回永久加载态', async () => {
  let calls = 0;
  const state = board({
    load: async () => {
      calls++;
      throw new Error('socket hang up');
    }
  });
  try {
    await state.board.inflight;
    assert.equal(state.panel.webview.messages.at(-1).type, 'error');
    await state.board.receive({ token: state.token, action: 'query', value: query });
    assert.equal(calls, 1);
    assert.equal(state.panel.webview.messages.at(-1).type, 'error');
    assert.match(state.panel.webview.messages.at(-1).message, /socket hang up/);
    assert.match(state.panel.webview.messages.at(-1).message, /60\s*秒/);
  } finally {
    state.owner.dispose();
  }
});

test('忽略取消的旧请求不能阻塞新的分页，也不能覆盖新页', { timeout: 1000 }, async () => {
  const pending = [];
  const state = board({
    load: (category, signal, request) => new Promise((resolve) => pending.push({ category, signal, request, resolve }))
  });
  try {
    await tick();
    await state.board.receive({ token: state.token, action: 'query', value: { ...query, page: 2 } });
    await tick();
    await tick();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].signal.aborted, true);
    const snapshot = { category: 'industry', rows: [], total: 60, source: '测试', fetchedAt: now };
    pending[1].resolve(snapshot);
    await state.board.inflight;
    pending[0].resolve({ ...snapshot, total: 300 });
    await tick();
    assert.equal(state.panel.webview.messages.at(-1).query.page, 2);
    assert.equal(state.panel.webview.messages.at(-1).data.total, 60);
  } finally {
    state.owner.dispose();
  }
});

test('整轮请求即使没有响应也能结束加载并提示超时', { timeout: 1000 }, async () => {
  let sourceSignal;
  const state = board({
    load: (_category, signal) => {
      sourceSignal = signal;
      return new Promise(() => {});
    }
  });
  try {
    state.board.requestTimeoutMs = 15;
    state.board.cancel();
    await tick();
    const inflight = state.board.inflight;
    await inflight;
    assert.equal(sourceSignal.aborted, true);
    assert.equal(state.panel.webview.messages.at(-1).type, 'error');
    assert.match(state.panel.webview.messages.at(-1).message, /超时/);
    assert.equal(state.board.inflight, undefined);
  } finally {
    state.owner.dispose();
  }
});

test('单个节点超时后切换备用节点，随后优先使用最近成功节点', async () => {
  let clock = now;
  const requests = [];
  const provider = new SectorBoardProvider(
    async (url, signal) => {
      const host = new URL(url).hostname;
      requests.push({ host, signal });
      return host === 'push2.eastmoney.com' ? new Promise(() => {}) : payload;
    },
    () => clock,
    15
  );
  const data = await provider.load('industry', new AbortController().signal, query);
  assert.equal(data.rows.length, 1);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].host, '82.push2.eastmoney.com');
  clock += 61000;
  await provider.load('industry', new AbortController().signal, query);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].host, '82.push2.eastmoney.com');
});

test('取消未响应的板块请求立即退出，不继续查询备用节点', async () => {
  let calls = 0;
  const provider = new SectorBoardProvider(
    () => {
      calls++;
      return new Promise(() => {});
    },
    () => now,
    1000
  );
  const controller = new AbortController();
  const pending = provider.load('industry', controller.signal, query);
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(calls, 1);
});
