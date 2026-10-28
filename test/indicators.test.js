'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { calculate } = require('../media/indicators');
const bars = closes => closes.map(close => ({ close, high: close + 1, low: close - 1 }));
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-9, `${value} != ${expected}`);

test('MACD首价初始化EMA，DIF/DEA/两倍柱与手算一致', () => {
  const result = calculate(bars([10, 11, 12]), 'macd');
  const dif1 = 2 / 13 - 2 / 27;
  near(result.lines[0].values[0], 0); near(result.lines[1].values[0], 0);
  near(result.lines[0].values[1], dif1); near(result.lines[1].values[1], dif1 / 5);
  near(result.histogram[1], 2 * dif1 * 4 / 5);
  const dif2 = 2 / 13 + 2 / 13 * (2 - 2 / 13) - (2 / 27 + 2 / 27 * (2 - 2 / 27));
  near(result.lines[0].values[2], dif2);
  near(result.lines[1].values[2], dif1 / 5 * .8 + dif2 * .2);
});

test('KDJ窗口满9根才输出，以50初始化K/D并保留J超出100的值', () => {
  const result = calculate(bars(Array.from({ length: 30 }, (_, i) => i + 10)), 'kdj');
  assert.ok(result.lines.every(s => s.values.slice(0, 8).every(v => v === null)));
  // First 9 bars: high=19, low=9, close=18 -> RSV=90.
  const k = (100 + 90) / 3, d = (100 + k) / 3;
  near(result.lines[0].values[8], k); near(result.lines[1].values[8], d); near(result.lines[2].values[8], 3 * k - 2 * d);
  assert.ok(result.lines[2].values.some(v => v > 100));
});

test('RSI使用前N个价差均值初始化及Wilder平滑，与独立样本一致', () => {
  const result = calculate(bars([10, 11, 10, 12, 11, 13, 12, 14]), 'rsi');
  const six = result.lines[0].values;
  assert.ok(six.slice(0, 6).every(v => v === null));
  near(six[6], 100 * 5 / 8);
  near(six[7], 100 * ((5 / 6 * 5 + 2) / 6) / (((5 / 6 * 5 + 2) / 6) + (3 / 6 * 5 / 6)));
  assert.ok(result.lines[1].values.every(v => v === null));
});

test('平价、单边、空数据和短样本不产生NaN或Infinity，不修改原始K线', () => {
  const flat = Array.from({ length: 35 }, () => ({ close: 10, high: 10, low: 10 }));
  const snapshot = JSON.stringify(flat);
  assert.ok(calculate(flat, 'macd').histogram.every(v => v === 0));
  for (const name of ['kdj', 'rsi']) assert.ok(calculate(flat, name).lines.every(s => s.values.every(v => v === null || v === 50)));
  for (const direction of [1, -1]) {
    const result = calculate(bars(Array.from({ length: 40 }, (_, i) => 50 + direction * i)), 'rsi');
    for (const s of result.lines) near(s.values.at(-1), direction === 1 ? 100 : 0);
  }
  for (const name of ['macd', 'kdj', 'rsi']) {
    assert.ok(calculate([], name).lines.every(s => s.values.length === 0));
    assert.ok(calculate(flat.slice(0, 1), name).lines.every(s => s.values.every(v => v === null || Number.isFinite(v))));
  }
  assert.equal(JSON.stringify(flat), snapshot); assert.equal(calculate(flat, 'none'), null);
});
