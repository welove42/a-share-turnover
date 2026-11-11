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
    '[data-map-sort]': ['amount', 'percent'].map((value) => new Element({ mapSort: value })),
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
  return { get, controls, messages, state };
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
  assert.equal(h.messages.at(-1).value.mapSort, 'percent');
  h.state(50, 1, 'percent', '', 'industry', 'gainers', 'heatmap', 'amount');
  assert.equal(h.get('heatmap').children.length, 0, '旧的成交额响应不能覆盖正在加载的涨幅榜');
  h.state(50, 1, 'percent', '', 'industry', 'gainers', 'heatmap', 'percent');
  assert.match(h.get('coverage').textContent, /涨幅排行/);
  h.state(50, 1, 'percent', '', 'industry', 'losers', 'heatmap', 'percent');
  assert.match(h.get('coverage').textContent, /跌幅排行/);
});
