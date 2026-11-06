'use strict';

const COLOR_KEYS = new Set(['stocks.colorMode', 'stocks.upColor', 'stocks.downColor']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_UP = '#f14c4c', DEFAULT_DOWN = '#55b873';

function stockColors(read) {
  const mode = read('stocks.colorMode', 'redUpGreenDown');
  const color = (key, fallback) => {
    const value = read(key, fallback);
    return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
  };
  return { mode: ['redUpGreenDown', 'neutral', 'custom'].includes(mode) ? mode : 'redUpGreenDown',
    up: color('stocks.upColor', DEFAULT_UP), down: color('stocks.downColor', DEFAULT_DOWN) };
}

// Stable primitive: unchanged quotes must not rewrite the status item.
function stockStatusColor(percent, palette) {
  if (!Number.isFinite(percent) || percent === 0 || palette.mode === 'neutral') return undefined;
  return palette.mode === 'custom' ? percent > 0 ? palette.up : palette.down : percent > 0 ? 'charts.red' : 'charts.green';
}

module.exports = { COLOR_KEYS, HEX_COLOR, stockColors, stockStatusColor };
