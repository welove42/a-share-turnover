'use strict';
// Pure calculations shared by the webview and Node tests. No remote scripts.
(() => {
  const line = (name, color, values) => ({ name, color, values });
  const colors = ['var(--chart-series-0, #e2bd65)', 'var(--chart-series-1, #bc8aff)', 'var(--chart-series-2, #5bbcff)'];
  function ema(values, period) {
    const alpha = 2 / (period + 1); let previous;
    return values.map(value => previous = previous === undefined ? value : previous + alpha * (value - previous));
  }
  function macd(bars) {
    const closes = bars.map(b => b.close), fast = ema(closes, 12), slow = ema(closes, 26);
    const dif = fast.map((value, i) => value - slow[i]), dea = ema(dif, 9);
    return { label: 'MACD (12,26,9)', lines: [line('DIF', colors[0], dif), line('DEA', colors[1], dea)],
      histogram: dif.map((value, i) => 2 * (value - dea[i])), levels: [0] };
  }
  function kdj(bars) {
    const k = [], d = [], j = []; let previousK = 50, previousD = 50;
    for (let i = 0; i < bars.length; i++) {
      if (i < 8) { k.push(null); d.push(null); j.push(null); continue; }
      const window = bars.slice(i - 8, i + 1), high = Math.max(...window.map(b => b.high)), low = Math.min(...window.map(b => b.low));
      const rsv = high === low ? 50 : 100 * (bars[i].close - low) / (high - low);
      previousK = (2 * previousK + rsv) / 3; previousD = (2 * previousD + previousK) / 3;
      k.push(previousK); d.push(previousD); j.push(3 * previousK - 2 * previousD);
    }
    return { label: 'KDJ (9,3,3)', lines: [line('K', colors[0], k), line('D', colors[1], d), line('J', colors[2], j)], levels: [20, 80], bounds: [0, 100] };
  }
  function rsiValues(bars, period) {
    const values = Array(bars.length).fill(null); let gain = 0, loss = 0;
    for (let i = 1; i < bars.length; i++) {
      const change = bars[i].close - bars[i - 1].close, up = Math.max(change, 0), down = Math.max(-change, 0);
      if (i <= period) { gain += up / period; loss += down / period; }
      else { gain = (gain * (period - 1) + up) / period; loss = (loss * (period - 1) + down) / period; }
      if (i >= period) values[i] = gain + loss === 0 ? 50 : 100 * gain / (gain + loss);
    }
    return values;
  }
  function calculate(bars, name) {
    if (name === 'macd') return macd(bars);
    if (name === 'kdj') return kdj(bars);
    if (name === 'rsi') return { label: 'RSI (6,12,24)', lines: [6, 12, 24].map((n, i) => line('RSI' + n, colors[i], rsiValues(bars, n))), levels: [20, 80], bounds: [0, 100] };
    return null;
  }
  const api = { calculate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.marketIndicators = api;
})();
