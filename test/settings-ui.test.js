'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function page() {
  const nodes = new Map(), sent = []; let receive;
  function element(tag) { const handlers = {}, attributes = {}; return { tag, children: [], dataset: {}, value: '', textContent: '', hidden: false, disabled: false,
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute(k, v) { attributes[k] = v; }, getAttribute(k) { return attributes[k]; },
    addEventListener(k, f) { handlers[k] = f; }, dispatch(k) { handlers[k]?.(); } }; }
  const document = { body: { dataset: { token: 'test' } }, activeElement: null, createElement: element, getElementById: id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/settings.js'), 'utf8'), { document, window: { addEventListener: (_, fn) => { receive = fn; } }, acquireVsCodeApi: () => ({ postMessage: m => sent.push(m) }) });
  return { nodes, sent, receive: message => receive({ data: { token: 'test', ...message } }) };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const model = () => [{ id: 'stocks', title: '自选与图表', actions: [], fields: [{ key: 'stocks.symbols', label: 'A 股自选', help: '', type: 'list', addLabel: '添加 A 股', value: ['sh600105'], items: [{ id: 'sh600105', name: '永鼎股份' }] }] }];
test('名单原位添加和移除使用当前分组与代码，错误后可重试', () => {
  const p = page(); p.receive({ type: 'state', groups: model() });
  const all = () => descendants(p.nodes.get('sections'));
  assert.ok(all().some(n => n.textContent === '永鼎股份')); assert.ok(all().some(n => n.textContent === 'sh600105'));
  const remove = all().find(n => n.getAttribute('aria-label') === '移除 永鼎股份 sh600105'); remove.dispatch('click');
  assert.equal(remove.disabled, true); assert.equal(p.sent.at(-1).operation, 'remove'); assert.equal(p.sent.at(-1).id, 'sh600105');
  p.receive({ type: 'result', key: 'stocks.symbols', ok: false, error: '保存失败' }); assert.equal(remove.disabled, false);
  const add = all().find(n => n.textContent === '+ 添加 A 股'); add.dispatch('click'); assert.equal(p.sent.at(-1).operation, 'add'); assert.equal(p.sent.at(-1).key, 'stocks.symbols');
});
test('长名单筛选名称或代码，删除成功只更新列表不丢失筛选词', () => {
  const p = page(), groups = model(), field = groups[0].fields[0];
  field.items = Array.from({ length: 10 }, (_, i) => ({ id: 'sh60010' + i, name: i === 5 ? '永鼎股份' : '股票' + i })); field.value = field.items.map(i => i.id);
  p.receive({ type: 'state', groups }); const all = () => descendants(p.nodes.get('sections'));
  const filter = all().find(n => n.getAttribute('aria-label') === '筛选A 股自选'); assert.equal(filter.hidden, false);
  filter.value = '永鼎'; filter.dispatch('input'); assert.equal(all().filter(n => n.tag === 'li').length, 1);
  all().find(n => n.getAttribute('aria-label') === '移除 永鼎股份 sh600105').dispatch('click');
  field.items = field.items.filter(i => i.id !== 'sh600105'); field.value = field.items.map(i => i.id);
  p.receive({ type: 'result', key: field.key, ok: true }); p.receive({ type: 'state', groups });
  assert.equal(filter.value, '永鼎'); assert.equal(all().filter(n => n.tag === 'li').length, 0); assert.ok(all().some(n => n.textContent === '没有匹配的名称或代码'));
});

test('A股分组原位管理、移动失败恢复原分组，折叠和筛选保留', () => {
  const p = page(), groups = model(), field = groups[0].fields[0];
  field.stockGroups = [{ id: 'watch', name: '观察', custom: true, symbols: ['sh600105'] }, { id: 'ungrouped', name: '未分组', custom: false, symbols: [] }];
  p.receive({ type: 'state', groups }); const all = () => descendants(p.nodes.get('sections'));
  assert.ok(all().some(n => n.textContent === '观察 (1)')); assert.ok(all().some(n => n.textContent === '未分组 (0)'));
  all().find(n => n.textContent === '+ 新建分组').dispatch('click'); assert.equal(p.sent.at(-1).type, 'stockGroup'); assert.equal(p.sent.at(-1).operation, 'create');
  p.receive({ type: 'result', key: field.key, ok: true });
  all().find(n => n.getAttribute('aria-label') === '重命名分组：观察').dispatch('click'); assert.equal(p.sent.at(-1).groupId, 'watch'); assert.equal(p.sent.at(-1).operation, 'rename');
  p.receive({ type: 'result', key: field.key, ok: true });
  const select = all().find(n => n.getAttribute('aria-label') === '移动 永鼎股份 到分组'); select.value = 'ungrouped'; select.dispatch('change');
  assert.equal(p.sent.at(-1).id, 'sh600105'); assert.equal(p.sent.at(-1).groupId, 'ungrouped');
  p.receive({ type: 'result', key: field.key, ok: false, error: '保存失败' });
  assert.equal(all().find(n => n.getAttribute('aria-label') === '移动 永鼎股份 到分组').value, 'watch');
  const details = all().find(n => n.tag === 'details'); details.open = false; details.dispatch('toggle');
  field.stockGroups[0].name = '重点观察'; p.receive({ type: 'state', groups }); assert.equal(all().find(n => n.tag === 'details').open, false);
  const filter = all().find(n => n.getAttribute('aria-label') === '筛选A 股自选'); filter.value = '重点观察'; filter.dispatch('input');
  assert.ok(all().some(n => n.textContent === '永鼎股份')); assert.equal(all().filter(n => n.tag === 'details').length, 1);
});
