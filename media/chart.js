'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const { token, symbol, regularUrl, chipsUrl } = document.body.dataset;
  const up = 'var(--chart-up, #f05b68)', down = 'var(--chart-down, #26bd8c)', lineColor = 'var(--chart-series-2, #5bbcff)';
  const modes = ['eastmoney', 'chips', 'intraday', 'intraday5', 'm1', 'm5', 'm15', 'm30', 'm60', 'daily', 'weekly', 'monthly'];
  const names = { intraday: '分时', intraday5: '5日分时', m1: '1分钟K', m5: '5分钟K', m15: '15分钟K', m30: '30分钟K', m60: '60分钟K', daily: '日K', weekly: '周K', monthly: '月K' };
  const isIntraday = value => value === 'intraday' || value === 'intraday5';
  const isWebMode = value => value === 'eastmoney' || value === 'chips';
  const webUrl = () => mode === 'chips' ? chipsUrl : regularUrl;
  const saved = vscode.getState() || {};
  const periodButtons = [...document.querySelectorAll('button[data-period]')];
  const indicatorButtons = [...document.querySelectorAll('button[data-indicator]')];
  let mode = 'intraday', data = null, range = [60, 120, 180].includes(saved.range) ? saved.range : 180, hover = null;
  let webTimer = null, pendingUrl = '', lastWebLoad = -Infinity;
  let indicator = 'macd', indicatorData = null, metrics = {}, averages = [], volumeAverages = [], legend = [];
  const send = (action, extra = {}) => vscode.postMessage({ action, token, ...extra });
  const remember = () => vscode.setState({ mode, range });
  const precision = /^(sh5|sz1)/.test(symbol) ? 3 : 2;
  const price = value => Number(value).toFixed(precision);
  const volume = value => value >= 1e8 ? (value / 1e8).toFixed(2) + '亿手' : value >= 1e4 ? (value / 1e4).toFixed(2) + '万手' : Number(value).toFixed(0) + '手';
  const amount = value => !Number.isFinite(value) ? '—' : value >= 1e8 ? (value / 1e8).toFixed(2) + '亿元' : value >= 1e4 ? (value / 1e4).toFixed(2) + '万元' : value.toFixed(2) + '元';
  const priceOrDash = value => Number.isFinite(value) ? price(value) : '—';
  const signed = (value, digits = 2) => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(digits)}` : '—';
  const clock = timestamp => timestamp ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} ${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}` : '';
  const guides = {
    macd: ['MACD (12,26,9) · 看趋势与动能', 'DIF是快慢均线之差，DEA是DIF的平滑线；柱值为2×(DIF−DEA)。DIF上穿DEA称金叉，下穿称死叉；零轴上方通常偏强、下方偏弱。柱变长表示两线差扩大，缩短表示差收窄，需结合价格与成交量判断。'],
    kdj: ['KDJ (9,3,3) · 看短线位置', 'K、D反映价格在近9个周期高低区间的位置，J放大两线差，可超出0–100。K、D高于80通常视为偏热、低于20偏冷；K上穿D称金叉，下穿称死叉。强趋势中会持续钝化，超买不等于马上下跌，超卖不等于马上反弹。'],
    rsi: ['RSI (6,12,24) · 看涨跌强弱', 'RSI在0–100之间，越高表示近期上涨相对更强，越低表示下跌相对更强。RSI6较敏感，RSI24较平滑；本图20/80虚线用于观察较极端的强弱位置。强弱状态可能持续，不能只凭高低值判断反转。'],
    none: ['副图已隐藏', '保留价格、均线与成交量；随时点击上方MACD、KDJ或RSI恢复副图。鼠标悬停仍可查看三种指标的数值。']
  };
  function updateIndicatorControls() {
    $('indicator-chart').hidden = indicator === 'none';
    for (const button of indicatorButtons) button.setAttribute('aria-pressed', String(button.dataset.indicator === indicator));
    const [title, body] = guides[indicator];
    $('indicator-guide-title').textContent = title;
    $('indicator-guide-body').textContent = body;
    $('indicator-guide-context').textContent = indicator === 'none' ? '' : (isIntraday(mode)
      ? '分时：按当日分钟采样价计算，每日重置；KDJ使用采样价区间，与完整1分钟K线不同。'
      : `当前${names[mode] || 'K线'}：参数按K线根数计算，使用已获取历史；最后一根未收盘时数值会变化。`) + ' 指标有滞后性，仅作辅助观察。';
  }
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
    $('web-chart').hidden = !isWebMode(mode); $('local').hidden = isWebMode(mode); $('range-label').hidden = isIntraday(mode) || isWebMode(mode);
    if (isWebMode(mode)) {
      loadWeb();
    } else {
      // Release the third-party document while the user is viewing native charts.
      cancelWebLoad(); $('eastmoney').removeAttribute('src');
      if (changed) { data = null; hover = null; indicatorData = null; $('svg').replaceChildren(); $('indicator-svg').replaceChildren(); $('chart-tooltip').hidden = true; $('meta').textContent = ''; $('quote').textContent = ''; $('detail').textContent = '移动鼠标查看价格、成交量与指标。'; $('average-detail').textContent = ''; $('indicator-detail').textContent = ''; $('indicator-note').textContent = ''; }
    }
    updateIndicatorControls();
    remember(); if (notify) send('mode-ready', { mode });
  }
  $('range').value = String(range);
  for (const button of periodButtons) button.addEventListener('click', () => send('period', { mode: button.dataset.period }));
  for (const button of indicatorButtons) button.addEventListener('click', () => {
    if (!isWebMode(mode) && button.dataset.indicator !== indicator) send('indicator', { indicator: button.dataset.indicator });
  });
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
    const all = data.bars, candles = !isIntraday(mode), fiveDay = mode === 'intraday5';
    let start = candles ? Math.max(0, all.length - range) : 0;
    if (candles && hover?.active) {
      const selectedIndex = all.findIndex(b => b.time === hover.bars[hover.index].time);
      if (selectedIndex >= 0) start = Math.min(start, selectedIndex);
    }
    const bars = candles ? all.slice(start, start + range) : all;
    const { calculate, movingAverage } = globalThis.marketIndicators;
    const compute = name => {
      if (!fiveDay) return calculate(all, name);
      const days = data.dates.map((_, i) => calculate(all.filter(bar => bar.dayIndex === i), name));
      const first = days[0];
      return { ...first, lines:first.lines.map((line,i)=>({ ...line, values:days.flatMap(day=>day.lines[i].values) })),
        ...(first.histogram ? { histogram:days.flatMap(day=>day.histogram) } : {}) };
    };
    metrics = Object.fromEntries(['macd', 'kdj', 'rsi'].map(name => [name, compute(name)]));
    indicatorData = metrics[indicator] || null;
    averages = candles ? [5, 10, 20, 30, 60].map((n, i) => ({ name: 'MA' + n, color: `var(--chart-series-${i})`, values: movingAverage(all, n) }))
      : [{ name: '均价', color: 'var(--chart-series-0)', values: all.map(b => b.averagePrice ?? null) }];
    volumeAverages = candles ? [5, 10].map((n, i) => ({ name: 'VMA' + n, color: `var(--chart-series-${i})`, values: movingAverage(all, n, 'volume') })) : [];
    legend = [];
    const withIndicator = Boolean(indicatorData);
    const svg = $('svg'), indicatorSvg = $('indicator-svg');
    // Each canvas uses the same horizontal coordinates and its own responsive height.
    const height = Math.round(svg.clientHeight * 1040 / svg.clientWidth) || 500;
    const indicatorHeight = Math.round(indicatorSvg.clientHeight * 1040 / indicatorSvg.clientWidth) || 220;
    const L = 68, R = 967, T = 40, B = height * .64, V = height * .77, VB = height - 45;
    const I = 35, IB = indicatorHeight - 40, bottom = VB;
    svg.setAttribute('viewBox', `0 0 1040 ${height}`);
    indicatorSvg.setAttribute('viewBox', `0 0 1040 ${indicatorHeight}`);
    const width = R - L, minute = time => {
      const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(2));
      return Math.max(0, Math.min(120, m - 570)) + Math.max(0, Math.min(120, m - 780));
    };
    const barMinute = bar => minute(fiveDay ? bar.time.slice(-5).replace(':','') : bar.time);
    const x = (bar, i) => candles ? L + (i + .5) * width / bars.length : fiveDay
      ? L + (bar.dayIndex + .02 + .96 * barMinute(bar) / 240) * width / data.dates.length : L + barMinute(bar) / 240 * width;
    let min = Math.min(...bars.map(b => b.low), ...averages.flatMap(a => a.values.slice(start, start + bars.length).filter(Number.isFinite)));
    let max = Math.max(...bars.map(b => b.high), ...averages.flatMap(a => a.values.slice(start, start + bars.length).filter(Number.isFinite)));
    if (mode === 'intraday' && data.previousClose) {
      const spread = Math.max(Math.abs(min - data.previousClose), Math.abs(max - data.previousClose), data.previousClose * .002);
      min = data.previousClose - spread; max = data.previousClose + spread;
    }
    const pad = Math.max((max - min) * .08, max * .001, .001); min -= pad; max += pad;
    const y = value => B - (value - min) / (max - min) * (B - T);
    const maxVolume = Math.max(...bars.map(b => b.volume), ...volumeAverages.flatMap(a => a.values.slice(start, start + bars.length).filter(Number.isFinite)), 1);
    const fragment = document.createDocumentFragment(), indicatorFragment = document.createDocumentFragment();
    let target = fragment;
    const add = (tag, attrs, text) => { const e = element(tag, attrs, text); target.append(e); return e; };
    const addLegend = (series, attrs, format = numberOrDash) => {
      const label = add('text', { ...attrs, 'data-series': series.name }, '');
      legend.push({ label, series, format }); return label;
    };
    const drawSeries = (series, yForValue, className) => {
      // Break a line at missing source values rather than bridging the gap.
      let points = [];
      const flush = () => {
        if (points.length === 1) { const [cx, cy] = points[0].split(','); add('circle', { cx, cy, r: 2, fill: series.color, class: className }); }
        else if (points.length) add('polyline', { points: points.join(' '), fill: 'none', stroke: series.color, 'stroke-width': 1.3, class: className });
        points = [];
      };
      bars.forEach((bar, i) => {
        const value = series.values[start + i];
        if (fiveDay && i && (bar.dayIndex !== bars[i-1].dayIndex || barMinute(bar) - barMinute(bars[i-1]) > 1)) flush();
        if (Number.isFinite(value)) points.push(`${x(bar, i)},${yForValue(value)}`); else flush();
      });
      flush();
    };
    for (let i = 0; i <= 4; i++) {
      const yy = T + i * (B - T) / 4, p = max - i * (max - min) / 4;
      add('line', { x1: L, x2: R, y1: yy, y2: yy, class: 'grid' }); add('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end' }, price(p));
      if (mode === 'intraday' && data.previousClose) add('text', { x: R + 8, y: yy + 4 }, `${((p / data.previousClose - 1) * 100).toFixed(2)}%`);
    }
    add('line', { x1: L, x2: R, y1: VB, y2: VB, class: 'grid' });
    add('text', { x: L, y: V - 12 }, `成交量 · 手  上限 ${volume(maxVolume)}`);
    if (mode === 'intraday' && data.previousClose) add('line', { x1: L, x2: R, y1: y(data.previousClose), y2: y(data.previousClose), class: 'baseline' });
    if (isIntraday(mode)) {
      if (fiveDay) drawSeries({color:lineColor,values:all.map(b=>b.close)}, y, 'intraday-price');
      else {
        add('polyline', { points: bars.map((b, i) => `${x(b, i)},${y(b.close)}`).join(' '), fill: 'none', stroke: lineColor, 'stroke-width': 1.8 });
        if (bars.length === 1) add('circle', { cx: x(bars[0], 0), cy: y(bars[0].close), r: 3, fill: lineColor });
      }
    }
    const barWidth = Math.max(1, Math.min(12, width / (candles ? bars.length : fiveDay ? data.dates.length * 241 : 241) * .65));
    bars.forEach((bar, i) => {
      const baseline = candles ? bar.open : fiveDay ? (i && bars[i-1].dayIndex === bar.dayIndex ? bars[i-1].close : bar.previousClose) : data.previousClose || bars[Math.max(0, i - 1)].close;
      const xx = x(bar, i), color = baseline == null ? 'var(--vscode-descriptionForeground)' : bar.close >= baseline ? up : down;
      if (candles) {
        add('line', { x1: xx, x2: xx, y1: y(bar.high), y2: y(bar.low), stroke: color, 'stroke-width': 1 });
        add('rect', { x: xx - barWidth / 2, y: Math.min(y(bar.open), y(bar.close)), width: barWidth, height: Math.max(1, Math.abs(y(bar.open) - y(bar.close))), fill: color });
      }
      const vh = bar.volume / maxVolume * (VB - V);
      add('rect', { x: xx - barWidth / 2, y: VB - vh, width: barWidth, height: vh, fill: color, opacity: .8 });
    });
    averages.forEach((a, index) => {
      drawSeries(a, y, candles ? 'price-average' : 'intraday-average');
      addLegend(a, { x: L + index * 175, y: 21, class: candles ? a.name.toLowerCase() : 'series-0' }, priceOrDash);
    });
    volumeAverages.forEach((a, index) => {
      drawSeries(a, value => VB - value / maxVolume * (VB - V), 'volume-average');
      addLegend(a, { x: L + 310 + index * 260, y: V - 12, class: 'series-' + index }, value => Number.isFinite(value) ? volume(value) : '—');
    });
    const ticks = fiveDay ? data.dates.map((date,i)=>[L+(i+.5)*width/data.dates.length,date.slice(5)]) : mode === 'intraday' ? [[L, '09:30'], [L + width / 4, '10:30'], [L + width / 2, '11:30 / 13:00'], [L + width * .75, '14:00'], [R, '15:00']]
      : [...new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1])].map(i => [x(bars[i], i), /^m\d+$/.test(mode) ? bars[i].time.slice(5) : bars[i].time]);
    if (withIndicator) {
      target = indicatorFragment;
      const lines = indicatorData.lines.map(s => ({ ...s, values: s.values.slice(start, start + bars.length) }));
      const histogram = indicatorData.histogram?.slice(start, start + bars.length);
      const values = lines.flatMap(s => s.values.filter(Number.isFinite)).concat((histogram || []).filter(Number.isFinite));
      let low = Math.min(...values, ...(indicatorData.bounds || []), ...indicatorData.levels);
      let high = Math.max(...values, ...(indicatorData.bounds || []), ...indicatorData.levels);
      if (high === low) { low -= 1; high += 1; }
      const padding = (high - low) * .08; low -= padding; high += padding;
      const iy = value => IB - (value - low) / (high - low) * (IB - I);
      add('text', { x: L, y: I - 16, class: 'indicator-title' }, indicatorData.label);
      indicatorData.lines.forEach((s, i) => addLegend(s, { x: L + 250 + i * 180, y: I - 16, class: 'series-' + i }));
      if (histogram) addLegend({ name: '柱', values: indicatorData.histogram }, { x: L + 610, y: I - 16 });
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
      if (fiveDay) indicatorData.lines.forEach(s => drawSeries(s, iy, 'indicator-line'));
      else lines.forEach(s => {
        const points = s.values.map((value, i) => Number.isFinite(value) ? `${x(bars[i], i)},${iy(value)}` : null).filter(Boolean);
        if (points.length === 1) { const [cx, cy] = points[0].split(','); add('circle', { cx, cy, r: 2, fill: s.color }); }
        else if (points.length) add('polyline', { points: points.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 1.5, class: 'indicator-line' });
      });
      if (!values.length) add('text', { x: (L + R) / 2, y: (I + IB) / 2, 'text-anchor': 'middle' }, '数据不足，等待更多周期');
    }
    const indicatorCross = withIndicator ? add('line', { x1: L, x2: L, y1: I, y2: IB, class: 'crosshair', visibility: 'hidden' }) : null;
    target = fragment;
    if (fiveDay) for (let i=1;i<data.dates.length;i++) add('line', { x1:L+i*width/data.dates.length, x2:L+i*width/data.dates.length, y1:T, y2:bottom, class:'grid' });
    ticks.forEach(([xx, text]) => add('text', { x: xx, y: bottom + 30, 'text-anchor': 'middle' }, text));
    const cross = add('line', { x1: L, x2: L, y1: T, y2: bottom, class: 'crosshair', visibility: 'hidden' });
    const marker = add('circle', { cx: L, cy: T, r: 3, fill: lineColor, visibility: 'hidden' });
    svg.replaceChildren(fragment);
    indicatorSvg.replaceChildren(indicatorFragment);
    $('plot').setAttribute('aria-label', `${data.name} ${names[mode]}图，${bars[0].time} 至 ${bars.at(-1).time}，最新价格 ${price(bars.at(-1).close)}${withIndicator ? '，副图 ' + indicatorData.label : ''}。可用左右方向键查看数据。`);
    $('indicator-note').textContent = !withIndicator ? '' : isIntraday(mode)
      ? '指标按当日分钟采样价格计算并每日重置；KDJ使用采样价范围，不代表完整1分钟K线高低价。'
      : `指标按${names[mode]}全量已获取记录计算后截取显示范围；不同历史长度及初始化方式可能产生数值差异。`;
    const selected = hover?.active && (candles || fiveDay || hover.date === data.date) ? bars.findIndex(b => b.time === hover.bars[hover.index].time) : -1;
    const side = hover?.side || 'right', panel = hover?.panel || 'main';
    hover = { bars, x, y, cross, indicatorCross, marker, L, R, start, index: bars.length - 1, date: data.date, active: false, side, panel };
    if (selected >= 0) pointAt(selected);
    else { $('chart-tooltip').hidden = true; detail(bars.at(-1), all.length - 1); }
  }
  const numberOrDash = value => Number.isFinite(value) ? value.toFixed(4) : '—';
  function detail(bar, index) {
    const time = mode === 'intraday' ? `${data.date} ${bar.time.slice(0, 2)}:${bar.time.slice(2)}` : bar.time;
    const previous = mode === 'intraday' ? data.previousClose : mode === 'intraday5' ? bar.previousClose : data.bars[index - 1]?.close;
    // Historical/weekly/monthly bars must use their preceding bar, not today's quote.
    const delta = Number.isFinite(previous) && previous > 0 ? bar.close - previous : null;
    const change = delta === null ? null : delta / previous * 100;
    const amplitude = delta === null ? null : (bar.high - bar.low) / previous * 100;
    const changes = `涨跌 ${signed(delta, precision)}　涨跌幅 ${signed(change)}%`;
    const mainAverages = averages.map(a => `${a.name} ${priceOrDash(a.values[index])}`);
    const volumeValues = volumeAverages.map(a => `${a.name} ${Number.isFinite(a.values[index]) ? volume(a.values[index]) : '—'}`);
    const indicatorText = item => `${item.label}　${item.lines.map(s => `${s.name} ${numberOrDash(s.values[index])}`).join('　')}${item.histogram ? '　柱 ' + numberOrDash(item.histogram[index]) : ''}`;
    for (const { label, series, format } of legend) label.textContent = `${series.name} ${format(series.values[index])}`;
    $('detail').textContent = !isIntraday(mode)
      ? `${time}　开 ${price(bar.open)}　高 ${price(bar.high)}　低 ${price(bar.low)}　收 ${price(bar.close)}　${changes}　振幅 ${signed(amplitude)}%　成交量 ${volume(bar.volume)}`
      : `${time}　价格 ${price(bar.close)}　${changes}　均价 ${priceOrDash(bar.averagePrice)}　该分钟成交量 ${volume(bar.volume)}　该分钟成交额 ${amount(bar.amount)}　累计成交额 ${amount(bar.cumulativeAmount)}`;
    $('average-detail').textContent = [...mainAverages, ...volumeValues].join('　');
    $('indicator-detail').textContent = !indicatorData ? '' : indicatorText(indicatorData);
    const rows = isIntraday(mode)
      ? [time, `价格 ${price(bar.close)}　均价 ${priceOrDash(bar.averagePrice)}`, changes,
        `分钟量 ${volume(bar.volume)}　累计量 ${Number.isFinite(bar.cumulativeVolume) ? volume(bar.cumulativeVolume) : '—'}`,
        `分钟额 ${amount(bar.amount)}　累计额 ${amount(bar.cumulativeAmount)}`]
      : [time, `开 ${price(bar.open)}　收 ${price(bar.close)}`, `高 ${price(bar.high)}　低 ${price(bar.low)}`,
        changes, `振幅 ${signed(amplitude)}%　量 ${volume(bar.volume)}`,
        mainAverages.slice(0, 3).join('　'), mainAverages.slice(3).join('　'), volumeValues.join('　')];
    $('chart-tooltip').textContent = [...rows, ...Object.values(metrics).map(indicatorText)].join('\n');
  }
  function pointAt(index) {
    if (!hover) return;
    hover.index = Math.max(0, Math.min(hover.bars.length - 1, index));
    hover.active = true;
    const bar = hover.bars[hover.index], xx = hover.x(bar, hover.index);
    hover.cross.setAttribute('x1', xx); hover.cross.setAttribute('x2', xx); hover.cross.setAttribute('visibility', 'visible'); detail(bar, hover.start + hover.index);
    if (hover.indicatorCross) { hover.indicatorCross.setAttribute('x1', xx); hover.indicatorCross.setAttribute('x2', xx); hover.indicatorCross.setAttribute('visibility', 'visible'); }
    hover.marker.setAttribute('cx', xx); hover.marker.setAttribute('cy', hover.y(bar.close)); hover.marker.setAttribute('visibility', 'visible');
    $('chart-tooltip').hidden = false;
    $('chart-tooltip').style.top = hover.panel === 'indicator' && indicator !== 'none' ? `${$('indicator-chart').offsetTop + 32}px` : '38px';
    $('chart-tooltip').style.left = hover.side === 'left' ? '12px' : 'auto';
    $('chart-tooltip').style.right = hover.side === 'right' ? '12px' : 'auto';
  }
  $('plot').addEventListener('pointermove', event => {
    if (!hover) return;
    const fromIndicator = event.target === $('indicator-svg') || event.target.ownerSVGElement === $('indicator-svg');
    // Buttons and reading notes are not part of the data hit area.
    if (event.target !== $('plot') && !fromIndicator && event.target !== $('svg') && event.target.ownerSVGElement !== $('svg')) return;
    hover.panel = fromIndicator ? 'indicator' : 'main';
    const transform = $(fromIndicator ? 'indicator-svg' : 'svg').getScreenCTM(); if (!transform) return;
    const xx = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse()).x;
    hover.side = xx > (hover.L + hover.R) / 2 ? 'left' : 'right';
    let best = 0;
    hover.bars.forEach((bar, i) => { if (Math.abs(hover.x(bar, i) - xx) < Math.abs(hover.x(hover.bars[best], best) - xx)) best = i; });
    pointAt(best);
  });
  function resetSelection() {
    if (!hover) return;
    hover.active = false;
    draw();
  }
  $('plot').addEventListener('pointerleave', resetSelection);
  $('plot').addEventListener('blur', event => { if (!indicatorButtons.includes(event.relatedTarget)) resetSelection(); });
  $('plot').addEventListener('keydown', event => {
    if (indicatorButtons.includes(event.target)) return;
    if (event.key === 'Escape') { resetSelection(); return; }
    if (hover && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); pointAt(hover.index + (event.key === 'ArrowLeft' ? -1 : 1)); }
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.token !== token) return;
    if (message.type === 'select-indicator' && ['macd', 'kdj', 'rsi', 'none'].includes(message.indicator)) { indicator = message.indicator; updateIndicatorControls(); draw(); return; }
    if (message.type === 'select-mode') { setMode(message.mode); return; }
    if (message.mode && message.mode !== mode) return;
    if (message.type === 'refresh' && isWebMode(mode)) { loadWeb(true); return; }
    if (message.type === 'loading') { $('status').className = ''; $('status').textContent = message.preserve ? '正在刷新，图表保留上次成功数据…' : '正在获取行情数据…'; }
    if (message.type === 'error') { $('status').className = 'error'; $('status').textContent = `${message.message}${message.preserve ? '；保留上次成功数据，等待下次刷新。' : '。可重试或在浏览器打开。'}`; }
    if (message.type === 'data' && message.data?.mode === mode && message.data.symbol === symbol) {
      data = message.data;
      $('status').className = ''; $('status').textContent = '';
      $('meta').textContent = `${data.source} · ${names[mode]} · ${isIntraday(mode) ? '分钟采样' : data.adjustment} · ${mode === 'intraday5' ? `交易日 ${data.dates.length} 天 · ` : ''}数据日期 ${data.date}${data.timestamp ? ` · 报价时间 ${clock(data.timestamp)}` : ''}（北京）`;
      const last = data.bars.at(-1).close, delta = data.previousClose ? (last / data.previousClose - 1) * 100 : null;
      $('quote').textContent = `${data.name} · ${symbol}　${price(last)}${delta === null || !isIntraday(mode) ? '' : `  ${delta >= 0 ? '▲ +' : '▼ '}${delta.toFixed(2)}%`}`;
      $('quote').style.color = delta === null || !isIntraday(mode) ? '' : delta >= 0 ? up : down;
      draw();
    }
  });
  // The host owns the selected symbol/mode; old Webview state only restores the range.
  // No remote navigation until the host confirms its latest selection.
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => draw()).observe($('plot'));
  window.addEventListener('pagehide', cancelWebLoad);
  updateIndicatorControls();
  send('ready');
})();
