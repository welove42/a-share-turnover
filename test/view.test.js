'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMinute, parseHistory, buildSnapshot, session } = require('../src/market');
const { view } = require('../src/view');
const { SYMBOLS, minutePayload, historyPayload } = require('./fixtures');
const NOW = new Date('2026-10-26T10:30:30+08:00');
const snapshot = () => buildSnapshot(SYMBOLS.map(s => parseMinute(minutePayload(s), s)),
  SYMBOLS.map(s => parseHistory(historyPayload(s), s)), NOW);
const config = { comparisonMode: 'sameTime', showDifferenceAmount: true, colorMode: 'neutral' };

test('精简状态栏只显示成交量、缩放量和可选差额，同刻时间与收盘状态留在悬浮', () => {
  const result = view(snapshot(), {}, config, session(NOW), NOW);
  assert.equal(result.text, '成交量 400.00亿 | 放量 99.00% (+198.00亿)');
  assert.doesNotMatch(result.text, /沪深A|同刻|10:30|交易中/);
  assert.match(result.markdown, /较昨同刻 10:30/);
  assert.match(result.markdown, /上一交易日：2026-10-23/);
  assert.match(result.markdown, /不含北交所/);
  assert.equal(result.color, undefined);
  const closed = new Date('2026-10-26T16:00:00+08:00');
  const afterClose = view(snapshot(), {}, config, session(closed), closed);
  assert.equal(afterClose.text, result.text); assert.match(afterClose.markdown, /已收盘/);
  assert.equal(view(snapshot(), {}, { ...config, showDifferenceAmount: false }, session(NOW), NOW).text, '成交量 400.00亿 | 放量 99.00%');
});

test('全天口径明确标注，使用全天的差额与百分比', () => {
  const result = view(snapshot(), {}, { ...config, comparisonMode: 'previousDay' }, session(NOW), NOW);
  assert.match(result.text, /较昨全天 缩量 33\.33% \(-200\.00亿\)/);
});

test('过期缓存、断网及上个交易日不会伪装成今天实时数据', () => {
  const s = snapshot();
  const tomorrow = new Date('2026-10-27T10:30:30+08:00');
  const result = view(s, { cached: true, error: '网络断开' }, config, session(tomorrow), tomorrow);
  assert.match(result.text, /\$\(warning\) 成交量 400\.00亿/);
  assert.doesNotMatch(result.text, /10-26/);
  assert.match(result.text, /行情未更新/);
  assert.match(result.markdown, /非今日行情/);
  assert.match(result.markdown, /上次成功数据/);
});

test('分时缺失显示比较待更新，不伪装成全天比较', () => {
  const s = snapshot(); s.sameTime = null; s.comparisonTime = null;
  assert.match(view(s, {}, config, session(NOW), NOW).text, /\| 比较待更新/);
});

test('无数据时提供重试；暂停保留展示；红放绿缩为可选设置', () => {
  assert.match(view(null, { error: '超时' }, config, session(NOW), NOW).text, /点击重试/);
  assert.match(view(snapshot(), { paused: true }, config, session(NOW), NOW).text, /已暂停/);
  assert.equal(view(snapshot(), {}, { ...config, colorMode: 'redUpGreenDown' }, session(NOW), NOW).color, 'charts.red');
  assert.equal(view(snapshot(), {}, { ...config, colorMode: 'redUpGreenDown', comparisonMode: 'previousDay' }, session(NOW), NOW).color, 'charts.green');
});

test('同一行情和状态下，经过几秒不会改变悬浮提示文本', () => {
  const s = snapshot();
  const first = view(s, {}, config, session(NOW), NOW);
  const later = new Date(NOW.getTime() + 9000);
  assert.equal(view(s, {}, config, session(later), later).markdown, first.markdown);
});
