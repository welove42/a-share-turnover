'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness } = require('./vscode-mock');
const now = new Date('2026-10-30T10:30:30+08:00');
test('状态栏菜单可切换板块、手动刷新，取消不改变设置', async () => {
  const h = harness(), { SectorsController, parseSectors } = h.load('../src/sectors');
  const calls = [];
  const c = new SectorsController(h.context, { now: () => now, provider: { load: async category => { calls.push(category); return parseSectors(data(), category, now.getTime()); } } });
  try {
    await c.refresh();
    h.api.window.showQuickPick = async items => { assert.equal(items[0].description, '当前显示'); return items.find(item => item.category === 'concept'); };
    await c.showMenu(); await (c.inflight || Promise.resolve());
    assert.equal(c.category, 'concept'); assert.equal(h.values.get('aShareTurnover.sectors.category'), 'concept');
    assert.match(c.item.tooltip.value, /概念板块/); assert.equal(calls.at(-1), 'concept');
    h.api.window.showQuickPick = async items => items.find(item => item.action === 'refresh');
    const before = calls.length; await c.showMenu(); assert.equal(calls.length, before + 1);
    h.api.window.showQuickPick = async () => undefined; await c.showMenu(); assert.equal(c.category, 'concept');
  } finally { c.dispose(); }
});
function data(timestamp = Math.floor(now.getTime() / 1000)) {
  return { rc: 0, data: { diff: Array.from({ length: 10 }, (_, i) => ({ f12: `BK${1000+i}`, f14: `板块${i}`, f3: 10-i, f124: timestamp })) } };
}
function sinaPage() {
  return `<section class="finlist_mod"><ul>${Array.from({length: 12}, (_, i) => `<li><span><a href="http://dp.sina.cn/bk?boardid=gn_test${i}&boardname=板块${i}">概念${i}</a></span><span class="f_red">+${(12-i).toFixed(2)}%</span></li>`).join('')}</ul></section>`;
}

test('跌幅榜请求服务端升序前十，行业与概念均适用，不反转涨幅前十', async () => {
  const { SectorProvider, parseSectors } = harness().load('../src/sectors'); const queries = [];
  const p = new SectorProvider(async url => {
    const query = new URL(url).searchParams; queries.push(query);
    const result = data(); if (query.get('po') === '0') for (const row of result.data.diff) { row.f3 = -row.f3; row.f12 = row.f12.replace('BK1', 'BK2'); }
    return result;
  });
  for (const category of ['industry', 'concept']) {
    const up = await p.load(category, undefined, now.getTime(), 'gainers'), down = await p.load(category, undefined, now.getTime(), 'losers');
    assert.equal(up[0].percent, 10); assert.equal(down[0].percent, -10); assert.equal(down.at(-1).percent, -1);
    assert.equal(up.some(a => down.some(b => a.code === b.code)), false);
    assert.equal(queries.at(-1).get('po'), '0'); assert.equal(queries.at(-2).get('po'), '1'); assert.equal(queries.at(-1).get('pz'), '10');
  }
  assert.equal(parseSectors(data(), 'industry', now.getTime(), 'losers')[0].percent, 1);
  await assert.rejects(p.load('industry', undefined, now.getTime(), 'wrong'), /排行方向/);
});

test('新浪备用从完整榜单末尾提取跌幅前十，涨跌切换共用60秒快照且不混方向', async () => {
  const { SectorProvider } = harness().load('../src/sectors'); let pages = 0;
  const allPage = sinaPage().replace('+12.00%', '-1.00%').replace(/\+(\d+\.\d+)%/g, (_, n) => `-${(13 - Number(n)).toFixed(2)}%`);
  const p = new SectorProvider(async () => { throw new Error('断开'); }, async () => { pages++; return allPage; });
  const up = await p.load('concept', undefined, now.getTime(), 'gainers');
  const down = await p.load('concept', undefined, now.getTime() + 1000, 'losers');
  assert.equal(pages, 1); assert.equal(up[0].name, '概念0'); assert.equal(up.at(-1).name, '概念9');
  assert.equal(down[0].name, '概念11'); assert.equal(down[0].percent, -12); assert.equal(down.at(-1).name, '概念2');
  assert.equal(down.length, 10); assert.equal(down[0].source, 'sina');
});

test('点击状态栏切换涨跌榜，保留板块类型；各方向分别缓存、重启恢复，取消不改变', async () => {
  const h = harness({ 'aShareTurnover.sectors.category': 'concept' }), { SectorsController, parseSectors } = h.load('../src/sectors');
  const calls = [], provider = { load: async (category, signal, time, direction) => {
    calls.push([category, direction]); const rows = data(); if (direction === 'losers') for (const r of rows.data.diff) { r.f3 = -r.f3; r.f14 = '下跌' + r.f14; }
    return parseSectors(rows, category, time, direction);
  } };
  const c = new SectorsController(h.context, { now: () => now, provider }); let restored;
  try {
    await c.refresh(); h.api.window.showQuickPick = async (items, options) => { assert.match(options.title, /概念板块.*涨幅前十/); return items.find(item => item.direction === 'losers'); };
    await c.showMenu(); await c.inflight;
    assert.deepEqual(calls.at(-1), ['concept', 'losers']); assert.equal(h.values.get('aShareTurnover.sectors.direction'), 'losers');
    assert.match(c.item.text, /领跌 下跌板块0 -10.00%/); assert.match(c.item.tooltip.value, /概念板块.*跌幅前十/); assert.match(c.item.tooltip.value, /10\. 下跌板块9 -1.00%/);
    assert.equal(h.store.get('sectorRankings').concept.direction, 'gainers'); assert.equal(h.store.get('sectorRankings')['concept:losers'].direction, 'losers');
    restored = new SectorsController(h.context, { now: () => now, provider }); restored.render(); assert.equal(restored.direction, 'losers'); assert.equal(restored.rows[0].percent, -10);
    h.api.window.showQuickPick = async () => undefined; await c.showMenu(); assert.equal(c.direction, 'losers');
    h.api.window.showQuickPick = async items => items.find(item => item.category === 'industry'); await c.showMenu(); await c.inflight;
    assert.deepEqual(calls.at(-1), ['industry', 'losers']); assert.match(c.item.tooltip.value, /行业板块.*跌幅前十/);
  } finally { restored?.dispose(); c.dispose(); }
});

test('切到跌幅榜立即清除旧涨幅行，迟到请求不能写入，旧版涨幅缓存不冒充跌幅榜', async () => {
  const h = harness(), { SectorsController, parseSectors } = h.load('../src/sectors'); const pending = [];
  h.store.set('sectorRankings', { industry: { category: 'industry', rows: parseSectors(data(), 'industry', now.getTime()) } });
  const c = new SectorsController(h.context, { now: () => now, provider: { load: (category, signal, time, direction) => new Promise(resolve => pending.push({ signal, direction, resolve })) } });
  try {
    assert.equal(c.rows[0].percent, 10); const old = c.refresh();
    await h.api.workspace.getConfiguration('aShareTurnover').update('sectors.direction', 'losers');
    assert.equal(pending[0].signal.aborted, true); assert.equal(c.rows, null); assert.equal(c.item.text, '领跌 待获取');
    pending[0].resolve(parseSectors(data(), 'industry', now.getTime())); await old; await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending[1].direction, 'losers'); assert.equal(c.rows, null);
    const down = data(); for (const r of down.data.diff) r.f3 = -r.f3;
    pending[1].resolve(parseSectors(down, 'industry', now.getTime(), 'losers')); await c.inflight;
    assert.equal(c.rows[0].percent, -10); assert.equal(h.store.get('sectorRankings').industry.rows[0].percent, 10);
  } finally { c.dispose(); }
});

test('备用跌幅缓存按升序恢复，只有少量下跌板块时说明排序口径，相同数据不重写悬停', async () => {
  const h = harness({ 'aShareTurnover.sectors.direction': 'losers', 'aShareTurnover.sectors.category': 'concept' }), { SectorProvider, SectorsController } = h.load('../src/sectors');
  const provider = new SectorProvider(async () => { throw new Error('失败'); }, async () => sinaPage());
  const c = new SectorsController(h.context, { now: () => now, provider }); let restored;
  try {
    await c.refresh(); assert.equal(c.rows[0].percent, 1); assert.match(c.item.tooltip.value, /从低到高/); assert.match(c.item.tooltip.value, /未提供行情时间/);
    const writes = c.item.writes.tooltip; await c.refresh(); assert.equal(c.item.writes.tooltip, writes);
    restored = new SectorsController(h.context, { now: () => now, provider }); restored.render(); assert.equal(restored.rows[0].percent, 1); assert.equal(restored.rows.at(-1).percent, 10);
    assert.match(restored.item.text, /领跌/);
  } finally { restored?.dispose(); c.dispose(); }
});
test('概念板块双域名断连后使用独立备用榜，恢复后回归东方财富', async () => {
  const h = harness(), { SectorProvider, parseSinaConcept } = h.load('../src/sectors');
  let fail = true, pages = 0;
  const p = new SectorProvider(async () => { if (fail) throw new Error('socket hang up'); return data(); }, async () => { pages++; return sinaPage(); });
  const rows = await p.load('concept', undefined, now.getTime());
  assert.equal(rows.length, 10); assert.equal(rows[0].source, 'sina'); assert.equal(rows[0].name, '概念0');
  await p.load('concept', undefined, now.getTime()+1000); assert.equal(pages, 1);
  fail = false; const recovered = await p.load('concept', undefined, now.getTime()+31000); assert.equal(recovered[0].name, '板块0'); assert.equal(pages, 1);
  assert.throws(() => parseSinaConcept(sinaPage().replace('+12.00%', '--'), now.getTime()), /字段无效/);
  assert.throws(() => parseSinaConcept(sinaPage().replace('+11.00%', '+99.00%'), now.getTime()), /顺序无效/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(p.load('concept', abort.signal, now.getTime()+60000), /取消/); assert.equal(pages, 1);
});
test('概念榜优先使用带原始行情时间的第三节点，三个节点都失败才使用新浪', async () => {
  const h = harness(), { SectorProvider } = h.load('../src/sectors'); const hosts = []; let pages = 0, thirdFails = false;
  const p = new SectorProvider(async url => { const host = new URL(url).hostname; hosts.push(host); if (host !== 'push2his.eastmoney.com' || thirdFails) throw new Error('socket hang up'); return data(); }, async () => { pages++; return sinaPage(); });
  const rows = await p.load('concept', undefined, now.getTime());
  assert.deepEqual(hosts, ['push2.eastmoney.com', '82.push2.eastmoney.com', 'push2his.eastmoney.com']);
  assert.equal(rows[0].timestamp, Math.floor(now.getTime()/1000)); assert.equal(rows[0].source, undefined); assert.equal(pages, 0);
  thirdFails = true; const fallback = await p.load('concept', undefined, now.getTime()+31000);
  assert.equal(fallback[0].source, 'sina'); assert.equal(pages, 1);
});
test('备用榜明确说明时间与口径，缓存恢复及切回主源不混淆时间', async () => {
  const h = harness({'aShareTurnover.sectors.category':'concept'}), { SectorsController, parseSectors, parseSinaConcept } = h.load('../src/sectors');
  let useSina = true; const provider = { load: async () => useSina ? parseSinaConcept(sinaPage(), now.getTime()) : parseSectors(data(Math.floor(now.getTime()/1000)-60), 'concept', now.getTime()) };
  const c = new SectorsController(h.context, { now: () => now, provider });
  try {
    await c.refresh(); assert.match(c.item.text, /参考/); assert.match(c.item.tooltip.value, /新浪概念板块.*分类口径/);
    assert.match(c.item.tooltip.value, /获取时间/); assert.match(c.item.tooltip.value, /未提供行情时间，不保证实时/); assert.doesNotMatch(c.item.tooltip.value, /行情时间：/);
    const restored = new SectorsController(h.context, { now: () => now, provider });
    try { restored.render(); assert.match(restored.item.text, /参考/); assert.equal(restored.rows.length, 10); } finally { restored.dispose(); }
    useSina = false; await c.refresh(); assert.match(c.item.tooltip.value, /东方财富概念板块/); assert.doesNotMatch(c.item.text, /参考/);
  } finally { c.dispose(); }
});
test('东方财富板块排名验证字段、按涨跌幅降序，损坏或不足十项不冒充完整榜单', async () => {
  const h = harness(), { parseSectors, SectorProvider } = h.load('../src/sectors');
  assert.equal(parseSectors(data(), 'industry', now.getTime())[0].name, '板块0');
  const bad = data(); bad.data.diff[0].f3 = '-'; assert.throws(() => parseSectors(bad, 'industry', now.getTime()), /不足十项/);
  let requested; const p = new SectorProvider(async url => { requested = url; return data(); });
  await p.load('concept', undefined, now.getTime()); const query = new URL(requested).searchParams;
  assert.equal(query.get('fs'), 'm:90+t:3+f:!50'); assert.equal(query.get('fid'), 'f3'); assert.equal(query.get('pz'), '10');
});
test('主接口断连时使用备用域名，冷却期间避免反复请求失败域名', async () => {
  const h = harness(), { SectorProvider } = h.load('../src/sectors'); const hosts = [];
  const p = new SectorProvider(async url => { const host = new URL(url).hostname; hosts.push(host); if (host === 'push2.eastmoney.com') throw new Error('断连'); return data(); });
  await p.load('industry', undefined, now.getTime()); await p.load('industry', undefined, now.getTime() + 10000);
  assert.deepEqual(hosts, ['push2.eastmoney.com', '82.push2.eastmoney.com', '82.push2.eastmoney.com']);
});
test('行业东方财富断连使用新浪行业榜，限频缓存并正确恢复，主源恢复后切回', async () => {
  const h = harness(), { SectorProvider, SectorsController } = h.load('../src/sectors');
  let failed = true, pages = 0, time = now;
  const page = sinaPage().replaceAll('gn_test', 'new_test');
  const provider = new SectorProvider(async () => { if (failed) throw new Error('socket hang up'); return data(); }, async url => { pages++; assert.match(url, /type=sina/); return page; });
  const c = new SectorsController(h.context, { provider, now: () => time });
  try {
    await c.refresh(); assert.equal(c.rows.length, 10); assert.match(c.item.text, /参考/);
    assert.match(c.item.tooltip.value, /新浪行业板块.*分类口径/); assert.match(c.item.tooltip.value, /未提供行情时间/);
    time = new Date(now.getTime()+10000); await c.refresh(); assert.equal(pages, 1);
    const restored = new SectorsController(h.context, { provider, now: () => time });
    try { restored.render(); assert.equal(restored.rows.length, 10); assert.match(restored.item.tooltip.value, /新浪行业板块/); } finally { restored.dispose(); }
    failed = false; time = new Date(now.getTime()+31000); await c.refresh();
    assert.match(c.item.tooltip.value, /东方财富行业板块/); assert.doesNotMatch(c.item.text, /参考/);
  } finally { c.dispose(); }
});
test('状态栏显示第一名与完整前十，刷新不重建相同悬停，失败保留并标注', async () => {
  const h = harness(), { SectorsController, parseSectors } = h.load('../src/sectors'); let failure = false, calls = 0, time = now;
  const c = new SectorsController(h.context, { now: () => time, provider: { load: async () => { calls++; if (failure) throw new Error('断网'); return parseSectors(data(), 'industry', time.getTime()); } } });
  try {
    await c.refresh(); assert.match(c.item.text, /领涨 板块0 \+10.00%/); assert.match(c.item.tooltip.value, /行业板块.*前十/);
    assert.match(c.item.tooltip.value, /10\. 板块9 \+1.00%/); const writes = c.item.writes.tooltip;
    await c.refresh(); assert.equal(c.item.writes.tooltip, writes);
    failure = true; await c.refresh(); assert.doesNotMatch(c.item.text, /未更新/); assert.match(c.item.tooltip.value, /未更新行情/); assert.match(c.item.tooltip.value, /断网/);
    assert.match(c.item.tooltip.value, /板块9/); time = new Date('2026-10-31T10:30:30+08:00'); c.render(); assert.match(c.item.tooltip.value, /2026-10-30/);
    assert.equal(calls, 3);
  } finally { c.dispose(); }
});
test('交易时段限频，午休停止；禁用和切换类型取消旧请求并忽略迟到数据', async () => {
  const h = harness(), { SectorsController, parseSectors } = h.load('../src/sectors'); let time = now, calls = 0, finish;
  const c = new SectorsController(h.context, { now: () => time, provider: { load: async () => { calls++; if (calls === 2) return new Promise(resolve => { finish = resolve; }); return parseSectors(data(), 'industry', time.getTime()); } } });
  try {
    await c.refresh(); time = new Date(now.getTime() + 9000); c.tick(); assert.equal(calls, 1);
    time = new Date(now.getTime() + 10000); c.tick(); assert.equal(calls, 2);
    await h.api.workspace.getConfiguration('aShareTurnover').update('sectors.enabled', false);
    finish(parseSectors(data(), 'industry', time.getTime())); await c.inflight; assert.equal(c.item.visible, false);
    time = new Date('2026-10-30T12:00:00+08:00'); c.enabled = true; c.tick(); assert.equal(calls, 2);
  } finally { c.dispose(); }
});
test('午休首次失败后自动重试，概念类型成功后保存且可从状态栏手动重试', async () => {
  const h = harness({'aShareTurnover.sectors.category':'concept'}), { SectorsController, parseSectors } = h.load('../src/sectors');
  let time = new Date('2026-10-30T12:00:00+08:00'), fail = true, calls = 0, reset = 0;
  const provider = { resetCooldowns() { reset++; }, load: async category => { calls++; if (fail) throw new Error('socket hang up'); return parseSectors(data(Math.floor(now.getTime()/1000)), category, time.getTime()); } };
  const c = new SectorsController(h.context, { now: () => time, provider });
  try {
    await c.refresh(); assert.equal(c.item.text, '领涨 获取失败'); assert.match(c.item.tooltip.value, /socket hang up/);
    time = new Date(time.getTime()+59000); c.tick(); assert.equal(calls,1);
    fail = false; time = new Date(time.getTime()+1000); c.tick(); await c.inflight;
    assert.equal(calls,2); assert.match(c.item.tooltip.value,/概念板块/); assert.equal(h.store.get('sectorRankings').concept.rows.length,10);
    await c.retry(); assert.equal(reset,1); assert.equal(calls,3); assert.equal(c.item.command, 'welove42.aShareTurnover.sectors.menu');
  } finally { c.dispose(); }
});
test('切换行业与概念时分别恢复对应缓存，不将行业排名冒充概念', async () => {
  const h = harness(), { SectorsController, parseSectors } = h.load('../src/sectors'); let time = now;
  const c = new SectorsController(h.context, { now: () => time, provider: { load: async category => parseSectors(data(), category, time.getTime()) } });
  try {
    await c.refresh(); await h.api.workspace.getConfiguration('aShareTurnover').update('sectors.category','concept');
    await new Promise(resolve=>setImmediate(resolve)); await c.inflight;
    assert.ok(h.store.get('sectorRankings').industry); assert.ok(h.store.get('sectorRankings').concept);
    await h.api.workspace.getConfiguration('aShareTurnover').update('sectors.category','industry');
    assert.match(c.item.tooltip.value,/行业板块/); assert.equal(c.rows.length,10);
  } finally { c.dispose(); }
});
test('概念板块盘中每60秒请求，失败后也不会提频，手动刷新可立即触发', async () => {
  const h = harness({'aShareTurnover.sectors.category':'concept'}), { SectorsController, parseSectors } = h.load('../src/sectors');
  let time = now, calls = 0, fail = false;
  const c = new SectorsController(h.context, { now: () => time, provider: { load: async category => { calls++; if (fail) throw new Error('断网'); return parseSectors(data(Math.floor(time.getTime()/1000)), category, time.getTime()); } } });
  try {
    await c.refresh(); assert.match(c.item.tooltip.value, /每60秒/);
    time = new Date(time.getTime()+59000); c.tick(); assert.equal(calls, 1);
    fail = true; time = new Date(time.getTime()+1000); c.tick(); await c.inflight; assert.equal(calls, 2);
    time = new Date(time.getTime()+30000); c.tick(); assert.equal(calls, 2);
    fail = false; await c.retry(); assert.equal(calls, 3);
    time = new Date(time.getTime()+59000); c.tick(); assert.equal(calls, 3);
    time = new Date(time.getTime()+1000); c.tick(); await c.inflight; assert.equal(calls, 4);
  } finally { c.dispose(); }
});
