'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const { token, symbol, regularUrl, chipsUrl } = document.body.dataset;
  const up = 'var(--chart-up, #f05b68)', down = 'var(--chart-down, #26bd8c)', lineColor = 'var(--chart-series-2, #5bbcff)';
  const modes = ['eastmoney', 'chips', 'intraday', 'daily', 'weekly', 'monthly'];
  const names = { intraday: '分时', daily: '日K', weekly: '周K', monthly: '月K' };
  const isWebMode = value => value === 'eastmoney' || value === 'chips';
  const webUrl = () => mode === 'chips' ? chipsUrl : regularUrl;
  const saved = vscode.getState() || {};
  const periodButtons = [...document.querySelectorAll('button[data-period]')];
  let mode = 'intraday', data = null, range = [60, 120, 180].includes(saved.range) ? saved.range : 180, hover = null;
  let webTimer = null, pendingUrl = '', lastWebLoad = -Infinity;
  let indicator = 'macd', indicatorData = null;
  const send = (action, extra = {}) => vscode.postMessage({ action, token, ...extra });
  const remember = () => vscode.setState({ mode, range });
  const precision = /^(sh5|sz1)/.test(symbol) ? 3 : 2;
  const price = value => Number(value).toFixed(precision);
  const volume = value => value >= 1e8 ? (value / 1e8).toFixed(2) + '亿手' : value >= 1e4 ? (value / 1e4).toFixed(2) + '万手' : Number(value).toFixed(0) + '手';
  const clock = timestamp => timestamp ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} ${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}` : '';
  function cancelWebLoad() { clearTimeout(webTimer); webTimer = null; pendingUrl = ''; }
  function loadWeb(force = false) {
    const url = webUrl(), frame = $('eastmoney');
    if (!url || pendingUrl === url || (!force && frame.getAttribute('src') === url)) return;
    if (force && frame.getAttribute('src') === url && Date.now() - lastWebLoad < 5000) return;
    cancelWebLoad();
    if (frame.getAttribute('src') !== url) frame.removeAttribute('src');
    pendingUrl = url;
    // Wait for a settled choice; the host may switch mode before the page is ready.
    webTimer = setTimeout(() => {
      webTimer = null; pendingUrl = '';
      if (isWebMode(mode) && webUrl() === url) { frame.src = url; lastWebLoad = Date.now(); }
    }, 400);
  }
  function setMode(next, notify = true) {
    if (!modes.includes(next)) return;
    if (next === 'chips' && !chipsUrl) next = 'intraday';
    const changed = mode !== next;
    mode = next;
    for (const button of periodButtons) button.setAttribute('aria-pressed', String(button.dataset.period === mode));
    $('web-chart').hidden = !isWebMode(mode); $('local').hidden = isWebMode(mode); $('range-label').hidden = mode === 'intraday' || isWebMode(mode);
    if (isWebMode(mode)) {
      loadWeb();
    } else {
      // Release the third-party document while the user is viewing native charts.
      cancelWebLoad(); $('eastmoney').removeAttribute('src');
      if (changed) { data = null; hover = null; indicatorData = null; $('svg').replaceChildren(); $('meta').textContent = ''; $('quote').textContent = ''; $('detail').textContent = '移动鼠标查看价格、成交量与指标。'; $('indicator-detail').textContent = ''; $('indicator-note').textContent = ''; }
    }
    remember(); if (notify) send('mode-ready', { mode });
  }
  $('range').value = String(range);
  for (const button of periodButtons) button.addEventListener('click', () => send('period', { mode: button.dataset.period }));
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
    const all = data.bars, candles = mode !== 'intraday', bars = candles ? all.slice(-range) : all;
    indicatorData = globalThis.marketIndicators.calculate(all, indicator);
    const withIndicator = Boolean(indicatorData);
    const start = all.length - bars.length, svg = $('svg');
    const height = withIndicator ? Math.max(440, Math.min(900, Math.round(svg.clientHeight * 1040 / svg.clientWidth) || 700)) : 550;
    const L = 68, R = 967, T = 40, B = withIndicator ? height * .46 : 380, V = withIndicator ? height * .53 : 430, VB = withIndicator ? height * .64 : 505;
    const I = height * .72, IB = height - 45, bottom = withIndicator ? IB : VB;
    svg.setAttribute('viewBox', `0 0 1040 ${height}`);
    const width = R - L, minute = time => {
      const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(2));
      return Math.max(0, Math.min(120, m - 570)) + Math.max(0, Math.min(120, m - 780));
    };
    const x = (bar, i) => candles ? L + (i + .5) * width / bars.length : L + minute(bar.time) / 240 * width;
    const ma = n => bars.map((_, i) => i + start + 1 >= n ? all.slice(i + start + 1 - n, i + start + 1).reduce((sum, b) => sum + b.close, 0) / n : null);
    const averages = candles ? [5, 10, 20].map((n, i) => ({ n, color: `var(--chart-series-${i})`, values: ma(n) })) : [];
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
    const barWidth = Math.max(1, Math.min(12, width / (candles ? bars.length : 241) * .65));
    bars.forEach((bar, i) => {
      const xx = x(bar, i), color = bar.close >= (candles ? bar.open : data.previousClose || bars[Math.max(0, i - 1)].close) ? up : down;
      if (candles) {
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
    if (withIndicator) {
      const lines = indicatorData.lines.map(s => ({ ...s, values: s.values.slice(start) }));
      const histogram = indicatorData.histogram?.slice(start);
      const values = lines.flatMap(s => s.values.filter(Number.isFinite)).concat((histogram || []).filter(Number.isFinite));
      let low = Math.min(...values, ...(indicatorData.bounds || []), ...indicatorData.levels);
      let high = Math.max(...values, ...(indicatorData.bounds || []), ...indicatorData.levels);
      if (high === low) { low -= 1; high += 1; }
      const padding = (high - low) * .08; low -= padding; high += padding;
      const iy = value => IB - (value - low) / (high - low) * (IB - I);
      add('text', { x: L, y: I - 16, class: 'indicator-title' }, indicatorData.label);
      lines.forEach((s, i) => add('text', { x: L + 250 + i * 180, y: I - 16, class: 'series-' + i }, `${s.name} ${numberOrDash(s.values.at(-1))}`));
      if (histogram) add('text', { x: L + 610, y: I - 16 }, `柱 ${numberOrDash(histogram.at(-1))}`);
      for (let i = 0; i <= 2; i++) {
        const value = low + (high - low) * i / 2, yy = iy(value);
        add('line', { x1: L, x2: R, y1: yy, y2: yy, class: 'grid' });
        add('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end' }, value.toFixed(indicator === 'macd' ? 3 : 1));
      }
      indicatorData.levels.forEach(level => add('line', { x1: L, x2: R, y1: iy(level), y2: iy(level), class: 'baseline' }));
      histogram?.forEach((value, i) => {
        if (value === 0) return;
        add('rect', { x: x(bars[i], i) - barWidth / 2, y: Math.min(iy(0), iy(value)), width: barWidth, height: Math.abs(iy(0) - iy(value)), fill: value >= 0 ? up : down, class: 'indicator-bar' });
      });
      lines.forEach(s => {
        const points = s.values.map((value, i) => Number.isFinite(value) ? `${x(bars[i], i)},${iy(value)}` : null).filter(Boolean);
        if (points.length === 1) { const [cx, cy] = points[0].split(','); add('circle', { cx, cy, r: 2, fill: s.color }); }
        else if (points.length) add('polyline', { points: points.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 1.5, class: 'indicator-line' });
      });
      if (!values.length) add('text', { x: (L + R) / 2, y: (I + IB) / 2, 'text-anchor': 'middle' }, '数据不足，等待更多周期');
    }
    ticks.forEach(([xx, text]) => add('text', { x: xx, y: bottom + 30, 'text-anchor': 'middle' }, text));
    const cross = add('line', { x1: L, x2: L, y1: T, y2: bottom, class: 'crosshair', visibility: 'hidden' });
    svg.replaceChildren(fragment);
    $('plot').setAttribute('aria-label', `${data.name} ${names[mode]}图，${bars[0].time} 至 ${bars.at(-1).time}，最新价格 ${price(bars.at(-1).close)}${withIndicator ? '，副图 ' + indicatorData.label : ''}。可用左右方向键查看数据。`);
    $('indicator-note').textContent = !withIndicator ? '' : mode === 'intraday'
      ? '指标按当日分钟采样价格计算并每日重置；KDJ使用采样价范围，不代表完整1分钟K线高低价。'
      : `指标按${names[mode]}全量已获取记录计算后截取显示范围；不同历史长度及初始化方式可能产生数值差异。`;
    hover = { bars, x, cross, L, R, start, index: bars.length - 1 };
    detail(bars.at(-1), all.length - 1);
  }
  const numberOrDash = value => Number.isFinite(value) ? value.toFixed(4) : '—';
  function detail(bar, index) {
    const time = mode === 'intraday' ? `${data.date} ${bar.time.slice(0, 2)}:${bar.time.slice(2)}` : bar.time;
    const change = data.previousClose ? (bar.close / data.previousClose - 1) * 100 : null;
    $('detail').textContent = mode !== 'intraday'
      ? `${time}　开 ${price(bar.open)}　高 ${price(bar.high)}　低 ${price(bar.low)}　收 ${price(bar.close)}　成交量 ${volume(bar.volume)}`
      : `${time}　价格 ${price(bar.close)}${change === null ? '' : `　涨跌幅 ${change > 0 ? '+' : ''}${change.toFixed(2)}%`}　该分钟成交量 ${volume(bar.volume)}`;
    $('indicator-detail').textContent = !indicatorData ? '' : `${indicatorData.label}　${indicatorData.lines.map(s => `${s.name} ${numberOrDash(s.values[index])}`).join('　')}${indicatorData.histogram ? '　柱 ' + numberOrDash(indicatorData.histogram[index]) : ''}`;
  }
  function pointAt(index) {
    if (!hover) return;
    hover.index = Math.max(0, Math.min(hover.bars.length - 1, index));
    const bar = hover.bars[hover.index], xx = hover.x(bar, hover.index);
    hover.cross.setAttribute('x1', xx); hover.cross.setAttribute('x2', xx); hover.cross.setAttribute('visibility', 'visible'); detail(bar, hover.start + hover.index);
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
    if (message.type === 'select-indicator' && ['macd', 'kdj', 'rsi', 'none'].includes(message.indicator)) { indicator = message.indicator; draw(); return; }
    if (message.type === 'select-mode') { setMode(message.mode); return; }
    if (message.mode && message.mode !== mode) return;
    if (message.type === 'refresh' && isWebMode(mode)) { loadWeb(true); return; }
    if (message.type === 'loading') { $('status').className = ''; $('status').textContent = message.preserve ? '正在刷新，图表保留上次成功数据…' : '正在获取行情数据…'; }
    if (message.type === 'error') { $('status').className = 'error'; $('status').textContent = `${message.message}${message.preserve ? '；保留上次成功数据，等待下次刷新。' : '。可重试或在浏览器打开。'}`; }
    if (message.type === 'data' && message.data?.mode === mode && message.data.symbol === symbol) {
      data = message.data;
      $('status').className = ''; $('status').textContent = '';
      $('meta').textContent = `${data.source} · ${names[mode]} · ${mode !== 'intraday' ? data.adjustment : '分钟采样'} · 数据日期 ${data.date}${data.timestamp ? ` · 报价时间 ${clock(data.timestamp)}` : ''}（北京）`;
      const last = data.bars.at(-1).close, delta = data.previousClose ? (last / data.previousClose - 1) * 100 : null;
      $('quote').textContent = `${data.name} · ${symbol}　${price(last)}${delta === null || mode !== 'intraday' ? '' : `  ${delta >= 0 ? '▲ +' : '▼ '}${delta.toFixed(2)}%`}`;
      $('quote').style.color = delta === null || mode !== 'intraday' ? '' : delta >= 0 ? up : down;
      draw();
    }
  });
  // The host owns the selected symbol/mode; old Webview state only restores the range.
  // No remote navigation until the host confirms its latest selection.
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => draw()).observe($('plot'));
  window.addEventListener('pagehide', cancelWebLoad);
  send('ready');
})();
