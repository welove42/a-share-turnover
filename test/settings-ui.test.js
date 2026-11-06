'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function page() {
  const nodes = new Map(), sent = [], timers = new Map(); let receive, timerId = 0;
  function element(tag) { const handlers = {}, attributes = {}; return { tag, children: [], dataset: {}, value: '', textContent: '', hidden: false, disabled: false,
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute(k, v) { attributes[k] = v; }, getAttribute(k) { return attributes[k]; },
    addEventListener(k, f) { handlers[k] = f; }, dispatch(k) { handlers[k]?.(); } }; }
  const document = { body: { dataset: { token: 'test' } }, activeElement: null, createElement: element, getElementById: id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/settings.js'), 'utf8'), { document, setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id), window: { addEventListener: (_, fn) => { receive = fn; } }, acquireVsCodeApi: () => ({ postMessage: m => sent.push(m) }) });
  return { nodes, sent, timers, receive: message => receive({ data: { token: 'test', ...message } }) };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const model = () => [{ id: 'stocks', title: '自选与图表', actions: [], fields: [{ key: 'stocks.symbols', label: 'A 股自选', help: '', type: 'list', addLabel: '添加 A 股', value: ['sh600105'], items: [{ id: 'sh600105', name: '永鼎股份' }] }] }];
const aiModel = () => [{ id: 'ai', title: 'AI 分析', actions: [{ id: 'ai.save', label: '保存配置' }, { id: 'ai.test', label: '测试连接' }], fields: [
  { key: 'ai.baseUrl', label: 'API 地址', type: 'string', value: 'https://example.com/v1' },
  { key: 'ai.apiKey', label: 'API Key', type: 'secret', configured: true, endpoint: 'https://example.com/v1' },
  { key: 'ai.model', label: '模型名称', type: 'string', value: 'test' }
] }];

test('Key直接在密码框输入，保存后清空草稿并遮挡；旧密钥不会作为表单值返回', () => {
  const p = page(), groups = aiModel(); p.receive({ type: 'state', groups });
  const all = () => descendants(p.nodes.get('sections')), input = all().find(n => n.id === 'field-ai.apiKey');
  assert.equal(input.type, 'password'); assert.equal(input.value, ''); assert.match(input.placeholder, /已保存/);
  input.value = 'new-test-secret'; input.dispatch('input');
  const toggle = all().find(n => n.getAttribute('aria-label') === '显示本次输入的 API Key'); toggle.dispatch('click'); assert.equal(input.type, 'text');
  all().find(n => n.textContent === '保存配置').dispatch('click'); const request = p.sent.at(-1);
  assert.equal(request.type, 'aiConfigure'); assert.equal(request.key, 'new-test-secret'); assert.equal(request.operation, 'save'); assert.equal(input.disabled, true);
  p.receive({ type: 'aiResult', id: request.id, operation: 'save', saved: true, ok: true, note: '配置已保存。' });
  assert.equal(input.value, ''); assert.equal(input.type, 'password'); assert.equal(input.disabled, false); assert.equal(p.timers.size, 0);
  assert.ok(all().some(n => /✓ 配置已保存/.test(n.textContent)));
});

test('连接测试原位反馈、禁止重复点击，成功和失败不会被行情刷新覆盖', () => {
  const p = page(), groups = aiModel(); p.receive({ type: 'state', groups }); const all = () => descendants(p.nodes.get('sections'));
  const b = all().find(n => n.textContent === '测试连接'), input = all().find(n => n.id === 'field-ai.apiKey');
  b.dispatch('click'); const request = p.sent.at(-1), count = p.sent.length;
  assert.equal(b.textContent, '测试中…'); assert.equal(b.disabled, true); assert.equal(input.disabled, true);
  assert.ok(all().some(n => /正在保存配置.*0 秒/.test(n.textContent)));
  b.dispatch('click'); assert.equal(p.sent.length, count);
  p.receive({ type: 'aiProgress', id: request.id, note: '等待模型回复' }); assert.ok(all().some(n => /等待模型回复/.test(n.textContent)));
  p.receive({ type: 'aiResult', id: request.id, ok: true, saved: true, operation: 'test', elapsedMs: 1450, note: '连接成功，可以开始分析。' });
  p.receive({ type: 'state', groups });
  const result = all().find(n => n.className === 'ai-result'); assert.match(result.textContent, /连接成功.*1.4 秒/); assert.equal(result.dataset.kind, 'success');
  b.dispatch('click'); const retry = p.sent.at(-1);
  p.receive({ type: 'aiResult', id: retry.id, ok: false, saved: true, operation: 'test', error: 'AI 接口 HTTP 401：Key 无效' });
  p.receive({ type: 'state', groups }); assert.match(result.textContent, /401/); assert.equal(result.dataset.kind, 'error'); assert.equal(b.disabled, false);
  assert.equal(p.timers.size, 0); assert.equal(input.value, '');
});

test('测试可取消，过期测试结果不能覆盖新测试，表单草稿不会被自动刷新清除', () => {
  const p = page(), groups = aiModel(); p.receive({ type: 'state', groups }); const all = () => descendants(p.nodes.get('sections'));
  const url = all().find(n => n.id === 'field-ai.baseUrl'), key = all().find(n => n.id === 'field-ai.apiKey');
  url.value = 'https://new.example/v1'; url.dispatch('input'); key.value = 'draft'; key.dispatch('input'); p.receive({ type: 'state', groups });
  assert.equal(url.value, 'https://new.example/v1'); assert.equal(key.value, 'draft'); assert.doesNotMatch(key.placeholder, /已保存/);
  const b = all().find(n => n.textContent === '测试连接'); b.dispatch('click'); const first = p.sent.at(-1);
  all().find(n => n.textContent === '取消测试').dispatch('click'); assert.equal(p.sent.at(-1).type, 'aiCancel');
  p.receive({ type: 'aiResult', id: first.id, ok: false, cancelled: true, error: '测试已取消。' });
  b.dispatch('click'); p.receive({ type: 'aiResult', id: first.id, ok: true, note: '连接成功' });
  assert.equal(b.disabled, true); assert.doesNotMatch(all().find(n => n.className === 'ai-result').textContent, /连接成功/);
});
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

test('港股和美股同名分组按钮与移动控件发送各自市场，不误用 A 股入口', () => {
  const p = page(), groups = [{ id: 'stocks', title: '自选与图表', actions: [], fields: ['hk', 'us'].map(market => ({
    key: `stocks.${market}Symbols`, label: market === 'hk' ? '港股自选' : '美股自选', help: '', type: 'list', addLabel: market === 'hk' ? '添加港股' : '添加美股',
    items: [{ id: market === 'hk' ? 'hk00700' : 'usAAPL', name: market === 'hk' ? '腾讯控股' : '苹果' }],
    value: [market === 'hk' ? 'hk00700' : 'usAAPL'],
    stockGroups: [{ id: 'watch', name: '观察', custom: true, symbols: [] }, { id: 'ungrouped', name: '未分组', custom: false, symbols: [market === 'hk' ? 'hk00700' : 'usAAPL'] }]
  })) }];
  p.receive({ type: 'state', groups }); const all = () => descendants(p.nodes.get('sections'));
  for (const [market, label, name] of [['hk', '港股', '腾讯控股'], ['us', '美股', '苹果']]) {
    all().find(n => n.getAttribute('aria-label') === `添加${label}：观察`).dispatch('click');
    assert.equal(p.sent.at(-1).key, `stocks.${market}Symbols`); assert.equal(p.sent.at(-1).operation, 'add'); assert.equal(p.sent.at(-1).groupId, 'watch');
    p.receive({ type: 'result', key: `stocks.${market}Symbols`, ok: true });
    const select = all().find(n => n.getAttribute('aria-label') === `移动 ${name} 到分组`); select.value = 'watch'; select.dispatch('change');
    assert.equal(p.sent.at(-1).key, `stocks.${market}Symbols`); assert.equal(p.sent.at(-1).operation, 'move');
    p.receive({ type: 'result', key: `stocks.${market}Symbols`, ok: true });
  }
});
