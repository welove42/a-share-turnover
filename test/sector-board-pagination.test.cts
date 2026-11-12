const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function ui() {
  class Element {
    constructor(dataset = {}) {
      Object.assign(this, { dataset, children: [], listeners: {}, textContent: '', value: '', hidden: false, disabled: false, style: {}, classList: { toggle() {} } });
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    fire(name) { if (!this.disabled) this.listeners[name]?.({ key: '', preventDefault() {} }); }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children.flatMap((child) => child.fragment ? child.children : [child]); }
    setAttribute() {}
  }
  const ids = new Map();
  const get = (id) => { if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id); };
  const controls = {
    '[data-category]': ['industry', 'concept'].map((value) => new Element({ category: value })),
    '[data-direction]': ['gainers', 'losers'].map((value) => new Element({ direction: value })),
    '[data-view]': ['table', 'heatmap'].map((value) => new Element({ view: value })),
    '[data-map-sort]': ['amount', 'gainers', 'losers'].map((value) => new Element({ mapSort: value })),
    '[data-sort]': ['percent', 'amount', 'volume'].map((value) => new Element({ sort: value })),
    '[data-page]': ['previous', 'next', 'previous', 'next'].map((value) => new Element({ page: value })),
    '[data-page-info]': [new Element(), new Element()]
  };
  const messages = [], listeners = {};
  const document = { body: { dataset: { token: 'test' } }, getElementById: get, querySelectorAll: (s) => controls[s] || [], createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/webviews/sector-board.js'), 'utf8'), {
    document, window: { addEventListener: (name, fn) => { listeners[name] = fn; } }, acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }), Date, Math, Number, String, Set, setTimeout, clearTimeout
  });
  const state = (count, page = 1, sort = 'percent', search = '', category = 'industry', direction = 'gainers', view = 'table', mapSort = 'amount') => listeners.message({ data: { token: 'test', type: 'state', category, direction, query: { view,page,sort,search,mapSort }, data: { source: '测试', fetchedAt: 0, total: count, rows: Array.from({ length: view === 'heatmap' ? Math.min(50,count) : Math.min(30, Math.max(0,count-(page-1)*30)) }, (_, i) => ({ code: `BK${1000 + i}`, name: `板块${i}`, percent: i, amount: 100 + i, volume: i, turnover: null, marketCap: null, up: 1, down: 0, leader: '', leaderPercent: null, timestamp: null })) } } });
  const receive = (message) => listeners.message({ data: { token: 'test', ...message } });
  return { get, controls, messages, state, receive };
}
test('板块列表分页、筛选和排序向后端发送正确查询，排名保持连续', async () => {
  const h = ui();
  h.state(63);
  assert.equal(h.get('rows').children.length, 30);
  assert.equal(h.controls['[data-page-info]'][0].textContent, '1 / 3 页');
  assert.equal(h.controls['[data-page]'][0].disabled, true);
  h.controls['[data-page]'][1].fire('click');
  assert.equal(h.messages.at(-1).value.page, 2);
  h.state(63, 2);
  assert.equal(h.get('rows').children.length, 30);
  assert.equal(h.get('rows').children[0].children[0].textContent, '31');
  assert.equal(h.controls['[data-page-info]'][1].textContent, '2 / 3 页');
  h.controls['[data-page]'][3].fire('click');
  h.state(63, 3);
  assert.equal(h.get('rows').children.length, 3);
  assert.equal(h.controls['[data-page]'][1].disabled, true);
  h.controls['[data-sort]'][1].fire('click');
  assert.equal(h.messages.at(-1).value.sort, 'amount');
  h.state(31, 1, 'amount');
  assert.equal(h.controls['[data-page-info]'][0].textContent, '1 / 2 页');
  h.controls['[data-page]'][1].fire('click');
  h.get('search').value = '板块1';
  h.get('search').fire('input');
  await new Promise((resolve) => setTimeout(resolve, 430));
  assert.equal(h.messages.at(-1).value.search, '板块1');
  h.state(11, 1, 'amount', '板块1');
  assert.equal(h.controls['[data-page-info]'][0].textContent, '1 / 1 页');
  assert.equal(h.get('rows').children.length, 11);
  h.get('search').value = '找不到';
  h.get('search').fire('input');
  await new Promise((resolve) => setTimeout(resolve, 430));
  h.state(0, 1, 'amount', '找不到');
  assert.equal(h.controls['[data-page-info]'][0].textContent, '0 / 0 页');
  assert.equal(h.get('rows').children[0].children[0].textContent, '没有找到匹配的板块');
  assert.equal(h.messages.filter((m) => m.action === 'query').length, 6);
});
test('云图最多50个板块，方块保留名称和涨跌幅且面积反映成交额', () => {
  const h = ui();
  h.state(60);
  h.controls['[data-view]'][1].fire('click');
  assert.equal(h.messages.at(-1).value.view, 'heatmap');
  h.state(50, 1, 'percent', '', 'industry', 'gainers', 'heatmap');
  const tiles = h.get('heatmap').children;
  assert.equal(tiles.length, 50);
  assert.ok(tiles.every((t) => t.children[0].textContent && t.children[1].textContent));
  const total = Array.from({length:50},(_,i)=>100+i).reduce((a,b)=>a+b,0);
  tiles.forEach((tile) => {
    const number = Number(tile.children[0].textContent.replace('板块',''));
    const ratio = parseFloat(tile.style.width) * parseFloat(tile.style.height) / 10000;
    assert.ok(Math.abs(ratio - (100 + number) / total) < 1e-8);
  });
  assert.match(h.get('coverage').textContent, /成交额排行/);
  h.controls['[data-map-sort]'][1].fire('click');
  assert.equal(h.messages.at(-1).value.mapSort, 'gainers');
  h.state(50, 1, 'percent', '', 'industry', 'gainers', 'heatmap', 'amount');
  assert.equal(h.get('heatmap').children.length, 0, '旧的成交额响应不能覆盖正在加载的涨幅榜');
  h.state(50, 1, 'percent', '', 'industry', 'gainers', 'heatmap', 'gainers');
  assert.match(h.get('coverage').textContent, /涨幅排行/);
  h.controls['[data-map-sort]'][2].fire('click');
  assert.equal(h.messages.at(-1).value.mapSort, 'losers');
  h.state(50, 1, 'percent', '', 'industry', 'gainers', 'heatmap', 'losers');
  assert.match(h.get('coverage').textContent, /跌幅排行/);
  assert.equal(h.get('directions').hidden, true);
});
test('备用源提示、真实单位和缺失时间正确显示，恢复主源后不残留新浪提示', () => {
  const h = ui();
  h.receive({
    type: 'state', category: 'industry', direction: 'gainers',
    data: {
      source: '新浪财经（备用）', sourceId: 'sina', notice: '新浪板块口径不同', fetchedAt: 0, total: 1,
      rows: [{
        code: 'new_blhy', name: '玻璃行业', percent: 2.11, volume: 4977853.65, amount: 7402524805,
        turnover: null, marketCap: null, up: null, down: null, leader: '亚玛顿', leaderPercent: 9.987, timestamp: null
      }]
    }
  });
  assert.match(h.get('source-note').textContent, /新浪板块口径不同/);
  assert.match(h.get('status').textContent, /新浪财经（备用）.*未提供行情时间/);
  assert.equal(h.get('rows').children[0].children[3].textContent, '74.03亿元');
  assert.equal(h.get('rows').children[0].children[4].textContent, '497.79万手');
  assert.equal(h.get('rows').children[0].children[5].textContent, '—');
  h.state(1);
  assert.equal(h.get('source-note').textContent, '');
});

test('49个板块集合相同时，切换涨幅仍改变排序、面积与说明', () => {
  const h = ui();
  const rows = Array.from({ length: 49 }, (_, i) => ({
    code: `BK${1000 + i}`, name: `板块${i}`, percent: i + 1, amount: 49 - i,
    volume: null, turnover: null, marketCap: null, up: null, down: null, leader: '', leaderPercent: null, timestamp: null
  }));
  const state = (mapSort) => h.receive({
    type: 'state', category: 'industry', direction: 'gainers',
    query: { view: 'heatmap', page: 1, sort: 'percent', search: '', mapSort },
    data: { source: '新浪财经（备用）', sourceId: 'sina', fetchedAt: 0, total: 49, rows }
  });
  const area = (tile) => parseFloat(tile.style.width) * parseFloat(tile.style.height) / 10000;
  h.controls['[data-view]'][1].fire('click');
  state('amount');
  let tiles = h.get('heatmap').children;
  const originalArea = area(tiles.find((tile) => tile.children[0].textContent === '板块48'));
  assert.equal(tiles.length, 49);
  assert.equal(tiles[0].children[0].textContent, '板块0');
  assert.match(h.get('map-hint').textContent, /面积代表板块成交额/);
  h.controls['[data-map-sort]'][1].fire('click');
  assert.equal(h.get('coverage').textContent, '', '加载中清除旧模式的数量');
  state('gainers');
  tiles = h.get('heatmap').children;
  assert.equal(tiles.length, 49);
  assert.equal(tiles[0].children[0].textContent, '板块48');
  assert.ok(Math.abs(area(tiles[0]) / originalArea - 49) < 1e-8);
  for (const tile of tiles) {
    const i = Number(tile.children[0].textContent.replace('板块', ''));
    assert.ok(Math.abs(area(tile) - (i + 1) / 1225) < 1e-8);
  }
  assert.match(h.get('map-hint').textContent, /仅显示上涨板块.*面积越大涨幅越高/);
  assert.match(h.get('coverage').textContent, /涨幅排行.*49.*49/);
  h.controls['[data-map-sort]'][2].fire('click');
  state('losers');
  assert.equal(h.get('heatmap').children.length, 0);
  assert.equal(h.get('heatmap').textContent, '暂无可展示的下跌板块');
  assert.match(h.get('coverage').textContent, /显示 0 个.*全部 49/);
  assert.match(h.get('map-hint').textContent, /仅显示下跌板块.*面积越大跌幅越深/);
});

test('涨跌云图严格区分方向，缺少成交额仍可展示，零涨跌不补足数量', () => {
  const h = ui();
  const rows = [-4, -1, 0, 2].map((percent, i) => ({
    code: `BK${1000 + i}`, name: `板块${i}`, percent, amount: null,
    volume: null, turnover: null, marketCap: null, up: null, down: null, leader: '', leaderPercent: null, timestamp: null
  }));
  const state = (mapSort, values = rows) => h.receive({
    type: 'state', category: 'industry', direction: 'gainers',
    query: { view: 'heatmap', page: 1, sort: 'percent', search: '', mapSort },
    data: { source: '测试', fetchedAt: 0, total: values.length, rows: values }
  });
  h.controls['[data-view]'][1].fire('click');
  state('amount');
  assert.equal(h.get('heatmap').children.length, 0);
  assert.match(h.get('heatmap').textContent, /暂无.*成交额/);
  h.controls['[data-map-sort]'][1].fire('click');
  state('gainers');
  assert.equal(h.get('heatmap').children.length, 1);
  assert.equal(h.get('heatmap').children[0].children[1].textContent, '+2.00%');
  state('gainers', rows.slice(0, 3));
  assert.equal(h.get('heatmap').textContent, '暂无可展示的上涨板块');
  h.controls['[data-map-sort]'][2].fire('click');
  state('losers');
  const tiles = h.get('heatmap').children;
  assert.deepEqual(tiles.map((tile) => tile.children[1].textContent), ['-4.00%', '-1.00%']);
  const areas = tiles.map((tile) => parseFloat(tile.style.width) * parseFloat(tile.style.height));
  assert.ok(Math.abs(areas[0] / areas[1] - 4) < 1e-8);
});
