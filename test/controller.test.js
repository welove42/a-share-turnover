'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { buildSnapshot, parseMinute, parseHistory } = require('../src/market');
const { SYMBOLS, minutePayload, historyPayload } = require('./fixtures');
const NOW = new Date('2026-10-26T10:30:30+08:00');
const snapshot = () => buildSnapshot(SYMBOLS.map(s => parseMinute(minutePayload(s), s)),
  SYMBOLS.map(s => parseHistory(historyPayload(s), s)), NOW);
let configurationListener;
const configValues = {};
function trackedStatusBarItem() {
  const values = {};
  const item = {
    writes: {}, showCalls: 0, hideCalls: 0,
    show() { this.visible = true; this.showCalls++; },
    hide() { this.visible = false; this.hideCalls++; }, dispose() {}
  };
  for (const property of ['text', 'tooltip', 'color', 'accessibilityInformation']) {
    item.writes[property] = 0;
    Object.defineProperty(item, property, {
      get: () => values[property],
      set: value => { values[property] = value; item.writes[property]++; }
    });
  }
  return item;
}
const vscode = {
  StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 },
  MarkdownString: class { constructor(value) { this.value = value; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: trackedStatusBarItem
  },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => configValues[key] ?? fallback }),
    onDidChangeConfiguration: listener => { configurationListener = listener; return { dispose() {} }; }
  }
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
const { TurnoverController } = require('../src/extension');
Module._load = originalLoad;

function setup(load) {
  let now = NOW;
  const store = new Map();
  const context = { globalState: { get: (key, fallback) => store.has(key) ? store.get(key) : fallback,
    update: async (key, value) => { store.set(key, value); } } };
  const controller = new TurnoverController(context, { load }, () => now);
  controller.lastDate = '2026-10-26'; controller.lastPhase = 'trading';
  return { controller, store, setNow: value => { now = new Date(value); } };
}

test('交易中10秒一次，不重叠；失败保留数据并在下个周期重试', async () => {
  let calls = 0, fail = false;
  const { controller: c, setNow } = setup(async () => { calls++; if (fail) throw new Error('断网'); return snapshot(); });
  try {
    await c.refresh(); assert.equal(calls, 1);
    setNow('2026-10-26T10:30:39+08:00'); await c.tick(); assert.equal(calls, 1);
    setNow('2026-10-26T10:30:40+08:00'); await c.tick(); assert.equal(calls, 2);
    fail = true; setNow('2026-10-26T10:30:50+08:00'); await c.tick();
    assert.equal(c.snapshot.amount, 400e8); assert.match(c.item.text, /行情未更新/);
    fail = false; setNow('2026-10-26T10:31:00+08:00'); await c.tick();
    assert.equal(calls, 4); assert.equal(c.state.error, '');
  } finally { c.dispose(); }
});

test('午休请求一次边界值后停止，13点恢复', async () => {
  let calls = 0;
  const { controller: c, setNow } = setup(async () => { calls++; return snapshot(); });
  try {
    setNow('2026-10-26T11:30:00+08:00'); await c.tick(); assert.equal(calls, 1);
    setNow('2026-10-26T12:00:00+08:00'); await c.tick(); assert.equal(calls, 1);
    setNow('2026-10-26T13:00:00+08:00'); await c.tick(); assert.equal(calls, 2);
  } finally { c.dispose(); }
});

test('进行中的请求合并；暂停和释放会取消请求', async () => {
  let resolve, signal, calls = 0;
  const { controller: c } = setup(s => { calls++; signal = s; return new Promise(r => { resolve = r; }); });
  try {
    const first = c.refresh(); const second = c.refresh();
    assert.equal(first, second); assert.equal(calls, 1);
    await c.togglePause(); assert.equal(signal.aborted, true);
    resolve(snapshot()); await first;
    assert.equal(c.snapshot, null);
    await c.tick(); assert.equal(calls, 1);
  } finally { c.dispose(); }
});

test('禁用后隐藏状态栏，释放后不再更新UI', async () => {
  const { controller: c } = setup(async () => snapshot());
  try {
    await c.refresh(); assert.equal(c.item.visible, true);
    configValues.enabled = false;
    configurationListener({ affectsConfiguration: () => true });
    assert.equal(c.item.visible, false);
    const oldText = c.item.text; c.dispose(); c.render(); assert.equal(c.item.text, oldText);
  } finally { delete configValues.enabled; c.dispose(); }
});

test('未来日期异常时拒绝覆盖成功快照', async () => {
  const { controller: c } = setup(async () => { const s = snapshot(); s.date = '2026-10-27'; return s; });
  try {
    await c.refresh(); assert.equal(c.snapshot, null); assert.match(c.state.error, /晚于北京时间/);
  } finally { c.dispose(); }
});

test('关闭再启用时等待取消中的请求，随后重新获取', async () => {
  let resolve, calls = 0;
  const { controller: c } = setup(() => {
    calls++;
    return calls === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve(snapshot());
  });
  try {
    const first = c.refresh();
    configValues.enabled = false; configurationListener({ affectsConfiguration: () => true });
    configValues.enabled = true; configurationListener({ affectsConfiguration: () => true });
    resolve(snapshot()); await first;
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 2);
    assert.equal(c.snapshot.amount, 400e8);
  } finally { delete configValues.enabled; c.dispose(); }
});

test('行情未变化时每秒时钟检查不重新写入状态栏或悬浮内容', async () => {
  const { controller: c, setNow } = setup(async () => snapshot());
  try {
    await c.refresh();
    const writes = { ...c.item.writes };
    const tooltip = c.item.tooltip;
    const showCalls = c.item.showCalls;
    for (let second = 31; second <= 39; second++) {
      setNow(`2026-10-26T10:30:${second}+08:00`);
      await c.tick();
    }
    assert.deepEqual(c.item.writes, writes);
    assert.equal(c.item.tooltip, tooltip);
    assert.equal(c.item.showCalls, showCalls);
  } finally { c.dispose(); }
});

test('已有行情时开始刷新和重复返回相同数据不会重建悬浮提示', async () => {
  const { controller: c } = setup(async () => snapshot());
  try {
    await c.refresh();
    const writes = { ...c.item.writes };
    const tooltip = c.item.tooltip;
    await c.refresh();
    assert.deepEqual(c.item.writes, writes);
    assert.equal(c.item.tooltip, tooltip);
  } finally { c.dispose(); }
});

test('新成交额、暂停及过期状态仍会及时更新，随后停止重复写入', async () => {
  const { controller: c, setNow } = setup(async () => snapshot());
  try {
    await c.refresh();
    const initial = c.item.tooltip;
    c.snapshot = { ...c.snapshot, amount: 500e8 };
    c.render();
    assert.match(c.item.text, /500\.00亿/);
    assert.notEqual(c.item.tooltip, initial);
    const updated = c.item.tooltip;
    c.render(); assert.equal(c.item.tooltip, updated);
    setNow('2026-10-26T10:33:31+08:00'); c.render();
    assert.match(c.item.text, /行情未更新/);
    const stale = c.item.tooltip;
    c.render(); assert.equal(c.item.tooltip, stale);
    await c.togglePause();
    assert.match(c.item.text, /已暂停/);
    assert.notEqual(c.item.tooltip, stale);
  } finally { c.dispose(); }
});

test('状态栏只在显示状态切换时调用show或hide', async () => {
  const { controller: c } = setup(async () => snapshot());
  try {
    await c.refresh();
    assert.equal(c.item.showCalls, 1);
    c.render(); assert.equal(c.item.showCalls, 1);
    configValues.enabled = false; configurationListener({ affectsConfiguration: () => true });
    c.render(); c.render(); assert.equal(c.item.hideCalls, 1);
    configValues.enabled = true; configurationListener({ affectsConfiguration: () => true });
    await new Promise(r => setImmediate(r));
    assert.equal(c.item.showCalls, 2);
  } finally { delete configValues.enabled; c.dispose(); }
});
