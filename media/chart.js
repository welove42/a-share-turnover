'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const { token, symbol, regularUrl, chipsUrl, mode: initialMode } = document.body.dataset;
  const up = '#f05b68', down = '#26bd8c', lineColor = '#5bbcff';
  const modes = ['eastmoney', 'chips', 'intraday', 'daily'];
  const isWebMode = value => value === 'eastmoney' || value === 'chips';
  const webUrl = () => mode === 'chips' ? chipsUrl : regularUrl;
  const saved = vscode.getState() || {};
  let mode = 'eastmoney', data = null, range = [60, 120, 180].includes(saved.range) ? saved.range : 180, hover = null;
  const send = (action, extra = {}) => vscode.postMessage({ action, token, ...extra });
  const remember = () => vscode.setState({ mode, range });
  const precision = /^(sh5|sz1)/.test(symbol) ? 3 : 2;
  const price = value => Number(value).toFixed(precision);
  const volume = value => value >= 1e8 ? (value / 1e8).toFixed(2) + '亿手' : value >= 1e4 ? (value / 1e4).toFixed(2) + '万手' : Number(value).toFixed(0) + '手';
  const clock = timestamp => timestamp ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} ${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}` : '';
  function setMode(next, notify = true) {
    if (!modes.includes(next)) return;
    if (next === 'chips' && !chipsUrl) next = 'eastmoney';
    const changed = mode !== next;
    mode = next;
    $('web-chart').hidden = !isWebMode(mode); $('local').hidden = isWebMode(mode); $('range-label').hidden = mode !== 'daily';
    if (isWebMode(mode)) {
      if ($('eastmoney').getAttribute('src') !== webUrl()) $('eastmoney').src = webUrl();
    } else {
      // Release the third-party document while the user is viewing native charts.
      $('eastmoney').removeAttribute('src');
      if (changed) { data = null; hover = null; $('svg').replaceChildren(); $('meta').textContent = ''; $('quote').textContent = ''; $('detail').textContent = '移动鼠标查看价格与成交量。'; }
    }
    remember(); if (notify) send('mode-ready', { mode });
  }
  $('range').value = String(range);
  $('range').addEventListener('change', () => { range = Number($('range').value); remember(); draw(); });
  const svgNS = 'http://www.w3.org/2000/svg';
  function element(tag, attrs, text) {
    const item = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function draw() {
    if (!data || data.mode !== mode) return;
    const all = data.bars, bars = mode === 'daily' ? all.slice(-range) : all;
    const start = all.length - bars.length, svg = $('svg');
    const L = 68, R = 967, T = 40, B = 380, V = 430, VB = 505;
    const width = R - L, minute = time => {
      const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(2));
      return Math.max(0, Math.min(120, m - 570)) + Math.max(0, Math.min(120, m - 780));
    };
    const x = (bar, i) => mode === 'daily' ? L + (i + .5) * width / bars.length : L + minute(bar.time) / 240 * width;
    const ma = n => bars.map((_, i) => i + start + 1 >= n ? all.slice(i + start + 1 - n, i + start + 1).reduce((sum, b) => sum + b.close, 0) / n : null);
    const averages = mode === 'daily' ? [5, 10, 20].map((n, i) => ({ n, color: ['#e2bd65', '#bc8aff', '#5bbcff'][i], values: ma(n) })) : [];
    let min = Math.min(...bars.map(b => b.low), ...averages.flatMap(a => a.values.filter(v => v !== null)));
    let max = Math.max(...bars.map(b => b.high), ...averages.flatMap(a => a.values.filter(v => v !== null)));
    if (mode === 'intraday' && data.previousClose) {
      const spread = Math.max(Math.abs(min - data.previousClose), Math.abs(max - data.previousClose), data.previousClose * .002);
      min = data.previousClose - spread; max = data.previousClose + spread;
    }
    const pad = Math.max((max - min) * .08, max * .001, .001); min -= pad; max += pad;
    const y = value => B - (value - min) / (max - min) * (B - T);
    const maxVolume = Math.max(...bars.map(b => b.volume), 1);
    const fragment = document.createDocumentFragment();
    const add = (tag, attrs, text) => { const e = element(tag, attrs, text); fragment.append(e); return e; };
    for (let i = 0; i <= 4; i++) {
      const yy = T + i * (B - T) / 4, p = max - i * (max - min) / 4;
      add('line', { x1: L, x2: R, y1: yy, y2: yy, class: 'grid' }); add('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end' }, price(p));
      if (mode === 'intraday' && data.previousClose) add('text', { x: R + 8, y: yy + 4 }, `${((p / data.previousClose - 1) * 100).toFixed(2)}%`);
    }
    add('line', { x1: L, x2: R, y1: VB, y2: VB, class: 'grid' });
    add('text', { x: L, y: V - 12 }, `成交量 · 手  上限 ${volume(maxVolume)}`);
    if (mode === 'intraday' && data.previousClose) add('line', { x1: L, x2: R, y1: y(data.previousClose), y2: y(data.previousClose), class: 'baseline' });
    if (mode === 'intraday') {
      add('polyline', { points: bars.map((b, i) => `${x(b, i)},${y(b.close)}`).join(' '), fill: 'none', stroke: lineColor, 'stroke-width': 1.8 });
      if (bars.length === 1) add('circle', { cx: x(bars[0], 0), cy: y(bars[0].close), r: 3, fill: lineColor });
    }
    const barWidth = Math.max(1, Math.min(12, width / (mode === 'daily' ? bars.length : 241) * .65));
    bars.forEach((bar, i) => {
      const xx = x(bar, i), color = bar.close >= (mode === 'daily' ? bar.open : data.previousClose || bars[Math.max(0, i - 1)].close) ? up : down;
      if (mode === 'daily') {
        add('line', { x1: xx, x2: xx, y1: y(bar.high), y2: y(bar.low), stroke: color, 'stroke-width': 1 });
        add('rect', { x: xx - barWidth / 2, y: Math.min(y(bar.open), y(bar.close)), width: barWidth, height: Math.max(1, Math.abs(y(bar.open) - y(bar.close))), fill: color });
      }
      const vh = bar.volume / maxVolume * (VB - V);
      add('rect', { x: xx - barWidth / 2, y: VB - vh, width: barWidth, height: vh, fill: color, opacity: .8 });
    });
    averages.forEach((a, index) => {
      const points = bars.map((bar, i) => a.values[i] === null ? null : `${x(bar, i)},${y(a.values[i])}`).filter(Boolean);
      if (points.length) add('polyline', { points: points.join(' '), fill: 'none', stroke: a.color, 'stroke-width': 1.3 });
      const last = a.values.at(-1);
      const label = add('text', { x: L + index * 185, y: 21 }, `MA${a.n} ${last === null ? '—' : price(last)}`);
      label.classList.add('ma' + a.n);
    });
    const ticks = mode === 'intraday' ? [[L, '09:30'], [L + width / 4, '10:30'], [L + width / 2, '11:30 / 13:00'], [L + width * .75, '14:00'], [R, '15:00']]
      : [...new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1])].map(i => [x(bars[i], i), bars[i].time]);
    ticks.forEach(([xx, text]) => add('text', { x: xx, y: 535, 'text-anchor': 'middle' }, text));
    const cross = add('line', { x1: L, x2: L, y1: T, y2: VB, class: 'crosshair', visibility: 'hidden' });
    svg.replaceChildren(fragment);
    $('plot').setAttribute('aria-label', `${data.name} ${mode === 'daily' ? '日K' : '分时'}图，${bars[0].time} 至 ${bars.at(-1).time}，最新价格 ${price(bars.at(-1).close)}。可用左右方向键查看数据。`);
    hover = { bars, x, cross, L, R, index: bars.length - 1 };
    detail(bars.at(-1));
  }
  function detail(bar) {
    const time = mode === 'intraday' ? `${data.date} ${bar.time.slice(0, 2)}:${bar.time.slice(2)}` : bar.time;
    const change = data.previousClose ? (bar.close / data.previousClose - 1) * 100 : null;
    $('detail').textContent = mode === 'daily'
      ? `${time}　开 ${price(bar.open)}　高 ${price(bar.high)}　低 ${price(bar.low)}　收 ${price(bar.close)}　成交量 ${volume(bar.volume)}`
      : `${time}　价格 ${price(bar.close)}${change === null ? '' : `　涨跌幅 ${change > 0 ? '+' : ''}${change.toFixed(2)}%`}　该分钟成交量 ${volume(bar.volume)}`;
  }
  function pointAt(index) {
    if (!hover) return;
    hover.index = Math.max(0, Math.min(hover.bars.length - 1, index));
    const bar = hover.bars[hover.index], xx = hover.x(bar, hover.index);
    hover.cross.setAttribute('x1', xx); hover.cross.setAttribute('x2', xx); hover.cross.setAttribute('visibility', 'visible'); detail(bar);
  }
  $('plot').addEventListener('pointermove', event => {
    if (!hover) return;
    const transform = $('svg').getScreenCTM(); if (!transform) return;
    const xx = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse()).x;
    let best = 0;
    hover.bars.forEach((bar, i) => { if (Math.abs(hover.x(bar, i) - xx) < Math.abs(hover.x(hover.bars[best], best) - xx)) best = i; });
    pointAt(best);
  });
  $('plot').addEventListener('pointerleave', () => { if (hover) hover.cross.setAttribute('visibility', 'hidden'); });
  $('plot').addEventListener('keydown', event => {
    if (hover && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); pointAt(hover.index + (event.key === 'ArrowLeft' ? -1 : 1)); }
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.token !== token) return;
    if (message.type === 'select-mode') { setMode(message.mode); return; }
    if (message.mode && message.mode !== mode) return;
    if (message.type === 'refresh' && isWebMode(mode)) { $('eastmoney').src = webUrl(); return; }
    if (message.type === 'loading') { $('status').className = ''; $('status').textContent = message.preserve ? '正在刷新，图表保留上次成功数据…' : '正在获取行情数据…'; }
    if (message.type === 'error') { $('status').className = 'error'; $('status').textContent = `${message.message}${message.preserve ? '；保留上次成功数据，等待下次刷新。' : '。可重试或在浏览器打开。'}`; }
    if (message.type === 'data' && message.data?.mode === mode && message.data.symbol === symbol) {
      data = message.data;
      $('status').className = ''; $('status').textContent = '';
      $('meta').textContent = `${data.source} · ${mode === 'daily' ? data.adjustment : '分钟分时'} · 数据日期 ${data.date}${data.timestamp ? ` · 报价时间 ${clock(data.timestamp)}` : ''}（北京）`;
      const last = data.bars.at(-1).close, delta = data.previousClose ? (last / data.previousClose - 1) * 100 : null;
      $('quote').textContent = `${data.name} · ${symbol}　${price(last)}${delta === null || mode === 'daily' ? '' : `  ${delta >= 0 ? '▲ +' : '▼ '}${delta.toFixed(2)}%`}`;
      $('quote').style.color = delta === null || mode === 'daily' ? '' : delta >= 0 ? up : down;
      draw();
    }
  });
  // The host owns the selected symbol/mode; old Webview state only restores the range.
  setMode(initialMode, false);
  send('ready');
})();
