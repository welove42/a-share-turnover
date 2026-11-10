/** 图表在浏览器本地绘制；切换副图无需请求网络，价格与成交量保持各自的缩放范围。 */
import type { PriceBar, IndicatorLine, IndicatorSeries } from '../../shared/types';
import { renderEtfReference, type EtfReferenceData } from './etf-reference';
import { MAX_HISTORY_BARS, supportsHistory } from '../../features/charts/history';
interface ChartData extends EtfReferenceData {
  symbol: string;
  mode: string;
  name: string;
  date: string;
  dates: string[];
  bars: PriceBar[];
  source: string;
  adjustment: string;
  timestamp?: string;
  previousClose: number | null;
  dailyHigh?: number | null;
  dailyLow?: number | null;
  dailyQuoteTimestamp?: string | null;
  turnoverApplicable?: boolean;
  turnoverRate?: number | null;
  turnoverTimestamp?: string | null;
  historicalStatus?: string;
  historicalError?: string;
  historicalSource?: string;
  historicalFetchedAt?: string;
  historyComplete?: boolean;
  historyReset?: boolean;
  klineFetchedAt?: number;
  klineStale?: boolean;
  klineWarning?: string;
}
interface HoverState {
  bars: PriceBar[];
  x: (bar: PriceBar, index: number) => number;
  y: (value: number) => number;
  cross: SVGElement;
  indicatorCross: SVGElement | null;
  marker: SVGElement;
  L: number;
  R: number;
  start: number;
  index: number;
  date: string;
  active: boolean;
  side: string;
  panel: string;
}
import { elements, isFiniteNumber } from '../shared/dom';
interface PageElements {
  'web-chart': HTMLElement;
  eastmoney: HTMLIFrameElement;
  local: HTMLElement;
  quote: HTMLElement;
  turnover: HTMLElement;
  detail: HTMLElement;
  'etf-reference': HTMLElement;
  'history-status': HTMLElement;
  'average-detail': HTMLElement;
  'indicator-detail': HTMLElement;
  'zoom-tools': HTMLElement;
  'zoom-in': HTMLButtonElement;
  'zoom-out': HTMLButtonElement;
  'history-tools': HTMLElement;
  'history-older': HTMLButtonElement;
  'history-newer': HTMLButtonElement;
  'history-all': HTMLButtonElement;
  'history-latest': HTMLButtonElement;
  'history-progress': HTMLElement;
  'range-info': HTMLElement;
  meta: HTMLElement;
  status: HTMLElement;
  plot: HTMLElement;
  svg: SVGSVGElement;
  'indicator-controls': HTMLElement;
  'indicator-chart': HTMLElement;
  'indicator-svg': SVGSVGElement;
  'indicator-guide': HTMLElement;
  'indicator-guide-title': HTMLElement;
  'indicator-guide-body': HTMLElement;
  'indicator-guide-context': HTMLElement;
  'chart-tooltip': HTMLElement;
  'indicator-note': HTMLElement;
}
import * as marketIndicators from '../../shared/indicators';
('use strict');
(() => {
  const vscode = acquireVsCodeApi();
  const $ = elements<PageElements>();
  const { token, symbol, regularUrl, chipsUrl } = document.body.dataset;
  const up = 'var(--chart-up, #f05b68)',
    down = 'var(--chart-down, #26bd8c)',
    lineColor = 'var(--chart-series-2, #5bbcff)';
  const modes = [
    'eastmoney',
    'chips',
    'intraday',
    'intraday5',
    'm1',
    'm5',
    'm15',
    'm30',
    'm60',
    'daily',
    'weekly',
    'monthly'
  ];
  const names = {
    intraday: '分时',
    intraday5: '5日分时',
    m1: '1分钟K',
    m5: '5分钟K',
    m15: '15分钟K',
    m30: '30分钟K',
    m60: '60分钟K',
    daily: '日K',
    weekly: '周K',
    monthly: '月K'
  };
  const isIntraday = (value) => value === 'intraday' || value === 'intraday5';
  const isWebMode = (value) => value === 'eastmoney' || value === 'chips';
  const webUrl = () => (mode === 'chips' ? chipsUrl : regularUrl);
  const saved = vscode.getState() || {};
  const periodButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-period]')];
  const indicatorButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-indicator]')];
  let mode = 'intraday',
    data: ChartData | null = null,
    range = Number.isInteger(saved.range) && saved.range >= 30 && saved.range <= MAX_HISTORY_BARS ? saved.range : 180,
    hover: HoverState | null = null;
  let windowEnd: string | null = null,
    pendingEnd: string | null = null,
    historyBusy = false,
    fitHistory = false,
    pendingRange: number | null = null;
  let webTimer: number | null = null,
    pendingUrl = '',
    lastWebLoad = -Infinity;
  let indicator = 'macd',
    indicatorData: IndicatorSeries | null = null,
    metrics: Record<string, IndicatorSeries> = {},
    averages: IndicatorLine[] = [],
    volumeAverages: IndicatorLine[] = [],
    legend: {
      label: SVGElement;
      series: Pick<IndicatorLine, 'name' | 'values'>;
      format: (value: number | null) => string;
    }[] = [];
  const send = (action, extra = {}) => vscode.postMessage({ action, token, ...extra });
  const remember = () => vscode.setState({ mode, range });
  const precision = /^(sh5|sz1)/.test(symbol || '') ? 3 : 2;
  const price = (value) => Number(value).toFixed(precision);
  const volume = (value) =>
    value >= 1e8
      ? (value / 1e8).toFixed(2) + '亿手'
      : value >= 1e4
        ? (value / 1e4).toFixed(2) + '万手'
        : Number(value).toFixed(Number.isInteger(value) ? 0 : 2) + '手';
  const amount = (value) =>
    !isFiniteNumber(value)
      ? '—'
      : value >= 1e8
        ? (value / 1e8).toFixed(2) + '亿元'
        : value >= 1e4
          ? (value / 1e4).toFixed(2) + '万元'
          : value.toFixed(2) + '元';
  const priceOrDash = (value) => (isFiniteNumber(value) ? price(value) : '—');
  const signed = (value, digits = 2) =>
    isFiniteNumber(value) ? `${value > 0 ? '+' : ''}${value.toFixed(digits)}` : '—';
  const percent = (value) => (isFiniteNumber(value) ? signed(value) + '%' : '—');
  const clock = (timestamp) =>
    timestamp
      ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} ${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}`
      : '';
  const guides = {
    macd: [
      'MACD (12,26,9) · 看趋势与动能',
      'DIF是快慢均线之差，DEA是DIF的平滑线；柱值为2×(DIF−DEA)。DIF上穿DEA称金叉，下穿称死叉；零轴上方通常偏强、下方偏弱。柱变长表示两线差扩大，缩短表示差收窄，需结合价格与成交量判断。'
    ],
    kdj: [
      'KDJ (9,3,3) · 看短线位置',
      'K、D反映价格在近9个周期高低区间的位置，J放大两线差，可超出0–100。K、D高于80通常视为偏热、低于20偏冷；K上穿D称金叉，下穿称死叉。强趋势中会持续钝化，超买不等于马上下跌，超卖不等于马上反弹。'
    ],
    rsi: [
      'RSI (6,12,24) · 看涨跌强弱',
      'RSI在0–100之间，越高表示近期上涨相对更强，越低表示下跌相对更强。RSI6较敏感，RSI24较平滑；本图20/80虚线用于观察较极端的强弱位置。强弱状态可能持续，不能只凭高低值判断反转。'
    ],
    none: ['副图已隐藏', '保留价格、均线与成交量；随时点击上方MACD、KDJ或RSI恢复副图。鼠标悬停仍可查看三种指标的数值。']
  };
  function updateIndicatorControls() {
    $('indicator-chart').hidden = indicator === 'none';
    for (const button of indicatorButtons)
      button.setAttribute('aria-pressed', String(button.dataset.indicator === indicator));
    const [title, body] = guides[indicator];
    $('indicator-guide-title').textContent = title;
    $('indicator-guide-body').textContent = body;
    $('indicator-guide-context').textContent =
      indicator === 'none'
        ? ''
        : (isIntraday(mode)
            ? '分时：按当日分钟采样价计算，每日重置；KDJ使用采样价区间，与完整1分钟K线不同。'
            : `当前${names[mode] || 'K线'}：参数按K线根数计算，使用已获取历史；最后一根未收盘时数值会变化。`) +
          ' 指标有滞后性，仅作辅助观察。';
  }
  function cancelWebLoad() {
    clearTimeout(webTimer ?? undefined);
    webTimer = null;
    pendingUrl = '';
  }
  function loadWeb(force = false) {
    const url = webUrl(),
      frame = $('eastmoney');
    if (!url || pendingUrl === url || (!force && frame.getAttribute('src') === url)) return;
    if (force && frame.getAttribute('src') === url && Date.now() - lastWebLoad < 5000) return;
    cancelWebLoad();
    if (frame.getAttribute('src') !== url) frame.removeAttribute('src');
    pendingUrl = url;
    // Wait for a settled choice; the host may switch mode before the page is ready.
    webTimer = setTimeout(() => {
      webTimer = null;
      pendingUrl = '';
      if (isWebMode(mode) && webUrl() === url) {
        frame.src = url;
        lastWebLoad = Date.now();
      }
    }, 400);
  }
  function setMode(next, notify = true) {
    if (!modes.includes(next)) return;
    if (next === 'chips' && !chipsUrl) next = 'intraday';
    const changed = mode !== next;
    mode = next;
    for (const button of periodButtons) button.setAttribute('aria-pressed', String(button.dataset.period === mode));
    $('web-chart').hidden = !isWebMode(mode);
    $('local').hidden = isWebMode(mode);
    $('zoom-tools').hidden = isIntraday(mode) || isWebMode(mode);
    $('history-tools').hidden = !supportsHistory(mode);
    if (changed) {
      windowEnd = null;
      pendingEnd = null;
      historyBusy = false;
      fitHistory = false;
      pendingRange = null;
      $('history-progress').textContent = '';
      $('range-info').textContent = '';
    }
    if (isWebMode(mode)) {
      loadWeb();
    } else {
      // Release the third-party document while the user is viewing native charts.
      cancelWebLoad();
      $('eastmoney').removeAttribute('src');
      if (changed) {
        data = null;
        hover = null;
        indicatorData = null;
        $('svg').replaceChildren();
        $('indicator-svg').replaceChildren();
        $('chart-tooltip').hidden = true;
        $('meta').textContent = '';
        $('quote').textContent = '';
        $('turnover').textContent = '';
        renderEtfReference($('etf-reference'), {}, Date.now());
        $('detail').textContent = '移动鼠标查看价格、成交量与指标。';
        $('history-status').textContent = '';
        $('average-detail').textContent = '';
        $('indicator-detail').textContent = '';
        $('indicator-note').textContent = '';
      }
    }
    updateIndicatorControls();
    remember();
    if (notify) send('mode-ready', { mode });
  }
  function updateZoom() {
    $('zoom-in').disabled = range <= 30;
    const canLoad = supportsHistory(mode) && !data?.historyComplete;
    $('zoom-out').disabled =
      historyBusy ||
      range >= MAX_HISTORY_BARS ||
      (!canLoad && Boolean(data?.mode === mode && range >= data.bars.length));
    const end = viewEnd();
    $('history-older').disabled = !data || historyBusy || (end <= range && !canLoad);
    $('history-newer').disabled = !data || end >= data.bars.length;
    $('history-latest').disabled = !data || (windowEnd === null && !fitHistory);
    $('history-all').disabled = !data || historyBusy || (fitHistory && Boolean(data.historyComplete));
  }
  function viewEnd(): number {
    if (!data) return 0;
    if (windowEnd === null) return data.bars.length;
    let index = data.bars.length - 1;
    while (index >= 0 && data.bars[index].time > windowEnd) index--;
    return Math.max(1, index + 1);
  }
  function requestHistory(all = false) {
    if (!data || historyBusy || !supportsHistory(mode) || data.historyComplete) return;
    historyBusy = true;
    updateZoom();
    $('history-progress').textContent = '正在加载更早走势…';
    send('history', { all });
  }
  function pan(direction: number) {
    if (!data || !supportsHistory(mode)) return;
    pendingEnd = null;
    pendingRange = null;
    fitHistory = false;
    if (hover) hover.active = false;
    const end = viewEnd(),
      step = Math.max(1, Math.round(Math.min(range, data.bars.length) * 0.8));
    if (direction < 0 && end <= range) {
      if (!data.historyComplete) {
        pendingEnd = data.bars[0].time;
        requestHistory();
      }
      return;
    }
    const next = Math.max(Math.min(range, data.bars.length), Math.min(data.bars.length, end + direction * step));
    windowEnd = next === data.bars.length ? null : data.bars[next - 1].time;
    updateZoom();
    draw();
  }
  $('history-older').addEventListener('click', () => pan(-1));
  $('history-newer').addEventListener('click', () => pan(1));
  $('history-latest').addEventListener('click', () => {
    windowEnd = null;
    pendingEnd = null;
    fitHistory = false;
    pendingRange = null;
    range = 180;
    if (hover) hover.active = false;
    remember();
    updateZoom();
    draw();
  });
  $('history-all').addEventListener('click', () => {
    if (!data) return;
    fitHistory = true;
    windowEnd = null;
    pendingEnd = null;
    range = Math.max(30, data.bars.length);
    if (hover) hover.active = false;
    requestHistory(true);
    updateZoom();
    draw();
  });
  function zoom(direction) {
    if (isIntraday(mode) || isWebMode(mode) || !data || data.mode !== mode) return false;
    pendingEnd = null;
    const next = Math.max(
      30,
      Math.min(
        MAX_HISTORY_BARS,
        range < 240 ? range + direction * 30 : Math.round((direction > 0 ? range * 1.5 : range / 1.5) / 30) * 30
      )
    );
    if (next === range) return false;
    fitHistory = false;
    if (direction < 0) pendingRange = null;
    if (direction > 0 && next > data.bars.length && supportsHistory(mode) && !data.historyComplete) {
      pendingRange = next;
      requestHistory();
    }
    range = Math.max(30, Math.min(next, data.bars.length));
    remember();
    updateZoom();
    draw();
    return true;
  }
  $('zoom-in').addEventListener('click', () => zoom(-1));
  $('zoom-out').addEventListener('click', () => zoom(1));
  $('plot').addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey || isIntraday(mode) || isWebMode(mode) || !data || data.mode !== mode || !event.deltaY) return;
      if (
        event.target !== $('plot') &&
        event.target !== $('svg') &&
        event.target !== $('indicator-svg') &&
        (event.target as SVGElement)?.ownerSVGElement !== $('svg') &&
        (event.target as SVGElement)?.ownerSVGElement !== $('indicator-svg')
      )
        return;
      event.preventDefault();
      zoom(event.deltaY < 0 ? -1 : 1);
    },
    { passive: false }
  );
  for (const button of periodButtons)
    button.addEventListener('click', () => send('period', { mode: button.dataset.period }));
  for (const button of indicatorButtons)
    button.addEventListener('click', () => {
      if (!isWebMode(mode) && button.dataset.indicator !== indicator)
        send('indicator', { indicator: button.dataset.indicator });
    });
  const svgNS = 'http://www.w3.org/2000/svg';
  function element(tag: string, attrs: Record<string, unknown>, text?: string | number) {
    const item = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
    if (text !== undefined) item.textContent = String(text);
    return item;
  }
  function draw() {
    if (!data || data.mode !== mode) return;
    const all = data.bars,
      candles = !isIntraday(mode),
      fiveDay = mode === 'intraday5';
    const end = candles ? viewEnd() : all.length;
    let start = candles ? Math.max(0, end - range) : 0;
    if (candles && hover?.active) {
      const selectedIndex = all.findIndex((b) => b.time === hover!.bars[hover!.index].time);
      if (selectedIndex >= 0) start = Math.min(start, selectedIndex);
    }
    const bars = candles ? all.slice(start, Math.min(end, start + range)) : all;
    $('range-info').textContent = supportsHistory(mode)
      ? `${bars[0].time} — ${bars.at(-1)!.time} · 显示 ${bars.length} / 已加载 ${all.length} 根`
      : '';
    const { calculate, movingAverage } = marketIndicators;
    const compute = (name) => {
      if (!fiveDay) return calculate(all, name)!;
      const days = data!.dates.map(
        (_, i) =>
          calculate(
            all.filter((bar) => bar.dayIndex === i),
            name
          )!
      );
      const first = days[0];
      return {
        ...first,
        lines: first.lines.map((line, i) => ({ ...line, values: days.flatMap((day) => day.lines[i].values) })),
        ...(first.histogram ? { histogram: days.flatMap((day) => day.histogram!) } : {})
      };
    };
    metrics = Object.fromEntries(['macd', 'kdj', 'rsi'].map((name) => [name, compute(name)]));
    indicatorData = metrics[indicator] || null;
    averages = candles
      ? [5, 10, 20, 30, 60].map((n, i) => ({
          name: 'MA' + n,
          color: `var(--chart-series-${i})`,
          values: movingAverage(all, n)
        }))
      : [{ name: '均价', color: 'var(--chart-series-0)', values: all.map((b) => b.averagePrice ?? null) }];
    volumeAverages = candles
      ? [5, 10].map((n, i) => ({
          name: 'VMA' + n,
          color: `var(--chart-series-${i})`,
          values: movingAverage(all, n, 'volume')
        }))
      : [];
    legend = [];
    const withIndicator = Boolean(indicatorData);
    const svg = $('svg'),
      indicatorSvg = $('indicator-svg');
    // Each canvas uses the same horizontal coordinates and its own responsive height.
    const height = Math.round((svg.clientHeight * 1040) / svg.clientWidth) || 500;
    const indicatorHeight = Math.round((indicatorSvg.clientHeight * 1040) / indicatorSvg.clientWidth) || 220;
    // Give the volume panel a substantial share of the available height.
    const L = 68,
      R = 967,
      T = 40,
      B = height * 0.59,
      V = height * 0.68,
      VB = height - 30;
    const I = 35,
      IB = indicatorHeight - 40,
      bottom = VB;
    svg.setAttribute('viewBox', `0 0 1040 ${height}`);
    indicatorSvg.setAttribute('viewBox', `0 0 1040 ${indicatorHeight}`);
    const width = R - L,
      minute = (time) => {
        const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(2));
        return Math.max(0, Math.min(120, m - 570)) + Math.max(0, Math.min(120, m - 780));
      };
    const barMinute = (bar) => minute(fiveDay ? bar.time.slice(-5).replace(':', '') : bar.time);
    const x = (bar, i) =>
      candles
        ? L + ((i + 0.5) * width) / bars.length
        : fiveDay
          ? L + (((bar.dayIndex ?? 0) + 0.02 + (0.96 * barMinute(bar)) / 240) * width) / data!.dates.length
          : L + (barMinute(bar) / 240) * width;
    let min = Math.min(
      ...bars.map((b) => b.low),
      ...averages.flatMap((a) => a.values.slice(start, start + bars.length).filter(isFiniteNumber))
    );
    let max = Math.max(
      ...bars.map((b) => b.high),
      ...averages.flatMap((a) => a.values.slice(start, start + bars.length).filter(isFiniteNumber))
    );
    // A quote provides prices but no timestamps for the extrema. Draw levels,
    // not points that imply an exact minute, and only on the matching date.
    const sameQuoteDay =
      isIntraday(mode) &&
      /^\d{14}$/.test(data.dailyQuoteTimestamp || '') &&
      (data.dailyQuoteTimestamp || '').slice(0, 8) === String(data.date || '').replaceAll('-', '');
    const high = sameQuoteDay && isFiniteNumber(data.dailyHigh) && data.dailyHigh > 0 ? data.dailyHigh : null;
    const low = sameQuoteDay && isFiniteNumber(data.dailyLow) && data.dailyLow > 0 ? data.dailyLow : null;
    const validRange = high === null || low === null || high >= low;
    const levels = validRange
      ? high !== null && high === low
        ? [{ label: '日高/日低', value: high }]
        : [
            ...(high !== null ? [{ label: '日最高', value: high }] : []),
            ...(low !== null ? [{ label: '日最低', value: low }] : [])
          ]
      : [];
    for (const level of levels) {
      min = Math.min(min, level.value);
      max = Math.max(max, level.value);
    }
    if (mode === 'intraday' && data.previousClose) {
      const spread = Math.max(
        Math.abs(min - data.previousClose),
        Math.abs(max - data.previousClose),
        data.previousClose * 0.002
      );
      min = data.previousClose - spread;
      max = data.previousClose + spread;
    }
    const pad = Math.max((max - min) * 0.08, max * 0.001, 0.001);
    min -= pad;
    max += pad;
    const y = (value) => B - ((value - min) / (max - min)) * (B - T);
    const maxVolume =
      Math.max(
        ...bars.map((b) => b.volume),
        ...volumeAverages.flatMap((a) => a.values.slice(start, start + bars.length).filter(isFiniteNumber)),
        0
      ) || 1;
    const fragment = document.createDocumentFragment(),
      indicatorFragment = document.createDocumentFragment();
    let target = fragment;
    const add = (tag: string, attrs: Record<string, unknown>, text?: string | number) => {
      const e = element(tag, attrs, text);
      target.append(e);
      return e;
    };
    const addLegend = (series, attrs, format = numberOrDash) => {
      const label = add('text', { ...attrs, 'data-series': series.name }, '');
      legend.push({ label, series, format });
      return label;
    };
    const drawSeries = (series, yForValue, className) => {
      // Break a line at missing source values rather than bridging the gap.
      let points: string[] = [];
      const flush = () => {
        if (points.length === 1) {
          const [cx, cy] = points[0]!.split(',');
          add('circle', { cx, cy, r: 2, fill: series.color, class: className });
        } else if (points.length)
          add('polyline', {
            points: points.join(' '),
            fill: 'none',
            stroke: series.color,
            'stroke-width': 1.3,
            class: className
          });
        points = [];
      };
      bars.forEach((bar, i) => {
        const value = series.values[start + i];
        if (fiveDay && i && (bar.dayIndex !== bars[i - 1].dayIndex || barMinute(bar) - barMinute(bars[i - 1]) > 1))
          flush();
        if (isFiniteNumber(value)) points.push(`${x(bar, i)},${yForValue(value)}`);
        else flush();
      });
      flush();
    };
    for (let i = 0; i <= 4; i++) {
      const yy = T + (i * (B - T)) / 4,
        p = max - (i * (max - min)) / 4;
      add('line', { x1: L, x2: R, y1: yy, y2: yy, class: 'grid' });
      add('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end' }, price(p));
      if (mode === 'intraday' && data.previousClose)
        add('text', { x: R + 8, y: yy + 4 }, `${((p / data.previousClose - 1) * 100).toFixed(2)}%`);
    }
    for (let i = 0; i <= 3; i++) {
      const yy = VB - ((VB - V) * i) / 3;
      add('line', {
        x1: L,
        x2: R,
        y1: yy,
        y2: yy,
        class: i === 0 ? 'grid volume-grid' : 'volume-grid volume-grid-guide'
      });
      // The panel heading already specifies lots; omit the suffix so long-history peaks fit the axis gutter.
      add(
        'text',
        { x: L - 8, y: yy + 4, 'text-anchor': 'end', class: 'volume-tick' },
        volume((maxVolume * i) / 3).replace(/手$/, '')
      );
    }
    add('text', { x: L, y: V - 10 }, '成交量 · 手');
    if (mode === 'intraday' && data.previousClose)
      add('line', { x1: L, x2: R, y1: y(data.previousClose), y2: y(data.previousClose), class: 'baseline' });
    const levelStart = fiveDay ? L + ((data.dates.length - 1) * width) / data.dates.length : L;
    levels.forEach((level, i) => {
      const yy = y(level.value),
        textY = Math.max(T + 11, Math.min(B - 3, yy + (i === 0 ? -4 : 13)));
      add('line', { x1: levelStart, x2: R, y1: yy, y2: yy, class: 'daily-extreme-line' });
      add(
        'text',
        { x: R - 4, y: textY, 'text-anchor': 'end', class: 'daily-extreme-label' },
        `${level.label} ${price(level.value)}`
      );
    });
    if (isIntraday(mode)) {
      if (fiveDay) drawSeries({ color: lineColor, values: all.map((b) => b.close) }, y, 'intraday-price');
      else {
        add('polyline', {
          points: bars.map((b, i) => `${x(b, i)},${y(b.close)}`).join(' '),
          fill: 'none',
          stroke: lineColor,
          'stroke-width': 1.8
        });
        if (bars.length === 1) add('circle', { cx: x(bars[0], 0), cy: y(bars[0].close), r: 3, fill: lineColor });
      }
    }
    const barWidth = Math.max(
      0.5,
      Math.min(
        12,
        (width / (candles ? bars.length : fiveDay ? data.dates.length * 241 : 241)) * (candles ? 0.65 : 0.85)
      )
    );
    // Batch dense candle/volume geometry into paths so decades of daily bars do not create tens of thousands of DOM nodes.
    const dense = candles && bars.length > 800;
    const shapes = new Map<string, { wicks: string[]; bodies: string[]; volumes: string[] }>();
    const rectangle = (x: number, y: number, w: number, h: number) =>
      `M${x.toFixed(2)},${y.toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h${(-w).toFixed(2)}Z`;
    bars.forEach((bar, i) => {
      const baseline = candles
        ? bar.open
        : fiveDay
          ? i && bars[i - 1].dayIndex === bar.dayIndex
            ? bars[i - 1].close
            : bar.previousClose
          : i
            ? bars[i - 1].close
            : data!.previousClose;
      const xx = x(bar, i),
        color = !isFiniteNumber(baseline)
          ? 'var(--vscode-descriptionForeground)'
          : bar.close > baseline || (candles && bar.close === baseline)
            ? up
            : bar.close < baseline
              ? down
              : 'var(--vscode-descriptionForeground)';
      const vh = (bar.volume / maxVolume) * (VB - V);
      if (dense) {
        if (!shapes.has(color)) shapes.set(color, { wicks: [], bodies: [], volumes: [] });
        const shape = shapes.get(color)!;
        shape.wicks.push(`M${xx.toFixed(2)},${y(bar.high).toFixed(2)}V${y(bar.low).toFixed(2)}`);
        shape.bodies.push(
          rectangle(
            xx - barWidth / 2,
            Math.min(y(bar.open), y(bar.close)),
            barWidth,
            Math.max(1, Math.abs(y(bar.open) - y(bar.close)))
          )
        );
        shape.volumes.push(rectangle(xx - barWidth / 2, VB - vh, barWidth, vh));
        return;
      }
      if (candles) {
        add('line', { x1: xx, x2: xx, y1: y(bar.high), y2: y(bar.low), stroke: color, 'stroke-width': 1 });
        add('rect', {
          x: xx - barWidth / 2,
          y: Math.min(y(bar.open), y(bar.close)),
          width: barWidth,
          height: Math.max(1, Math.abs(y(bar.open) - y(bar.close))),
          fill: color
        });
      }
      add('rect', { x: xx - barWidth / 2, y: VB - vh, width: barWidth, height: vh, fill: color, class: 'volume-bar' });
    });
    for (const [color, shape] of shapes) {
      add('path', { d: shape.wicks.join(''), stroke: color, 'stroke-width': 1, fill: 'none' });
      add('path', { d: shape.bodies.join(''), fill: color });
      add('path', { d: shape.volumes.join(''), fill: color, class: 'volume-bar' });
    }
    averages.forEach((a, index) => {
      drawSeries(a, y, candles ? 'price-average' : 'intraday-average');
      addLegend(a, { x: L + index * 175, y: 21, class: candles ? a.name.toLowerCase() : 'series-0' }, priceOrDash);
    });
    volumeAverages.forEach((a, index) => {
      drawSeries(a, (value) => VB - (value / maxVolume) * (VB - V), 'volume-average');
      addLegend(a, { x: L + 310 + index * 260, y: V - 10, class: 'series-' + index }, (value) =>
        isFiniteNumber(value) ? volume(value) : '—'
      );
    });
    const ticks = fiveDay
      ? data.dates.map((date, i) => [L + ((i + 0.5) * width) / data!.dates.length, date.slice(5)])
      : mode === 'intraday'
        ? [
            [L, '09:30'],
            [L + width / 4, '10:30'],
            [L + width / 2, '11:30 / 13:00'],
            [L + width * 0.75, '14:00'],
            [R, '15:00']
          ]
        : [...new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1])].map((i) => [
            x(bars[i], i),
            /^m\d+$/.test(mode) ? bars[i].time.slice(5) : bars[i].time
          ]);
    if (indicatorData) {
      target = indicatorFragment;
      const lines = indicatorData.lines.map((s) => ({ ...s, values: s.values.slice(start, start + bars.length) }));
      const histogram = indicatorData.histogram?.slice(start, start + bars.length);
      const values = lines
        .flatMap((s) => s.values.filter(isFiniteNumber))
        .concat((histogram || []).filter(isFiniteNumber));
      let low = Math.min(...values, ...(indicatorData.bounds || []), ...indicatorData.levels);
      let high = Math.max(...values, ...(indicatorData.bounds || []), ...indicatorData.levels);
      if (high === low) {
        low -= 1;
        high += 1;
      }
      const padding = (high - low) * 0.08;
      low -= padding;
      high += padding;
      const iy = (value) => IB - ((value - low) / (high - low)) * (IB - I);
      add('text', { x: L, y: I - 16, class: 'indicator-title' }, indicatorData.label);
      indicatorData.lines.forEach((s, i) => addLegend(s, { x: L + 250 + i * 180, y: I - 16, class: 'series-' + i }));
      if (histogram) addLegend({ name: '柱', values: indicatorData.histogram }, { x: L + 610, y: I - 16 });
      for (let i = 0; i <= 2; i++) {
        const value = low + ((high - low) * i) / 2,
          yy = iy(value);
        add('line', { x1: L, x2: R, y1: yy, y2: yy, class: 'grid' });
        add('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end' }, value.toFixed(indicator === 'macd' ? 3 : 1));
      }
      indicatorData.levels.forEach((level) =>
        add('line', { x1: L, x2: R, y1: iy(level), y2: iy(level), class: 'baseline' })
      );
      const histogramShapes = new Map<string, string[]>();
      histogram?.forEach((value, i) => {
        if (value === 0) return;
        if (dense) {
          const color = value >= 0 ? up : down;
          if (!histogramShapes.has(color)) histogramShapes.set(color, []);
          histogramShapes
            .get(color)!
            .push(
              rectangle(x(bars[i], i) - barWidth / 2, Math.min(iy(0), iy(value)), barWidth, Math.abs(iy(0) - iy(value)))
            );
          return;
        }
        add('rect', {
          x: x(bars[i], i) - barWidth / 2,
          y: Math.min(iy(0), iy(value)),
          width: barWidth,
          height: Math.abs(iy(0) - iy(value)),
          fill: value >= 0 ? up : down,
          class: 'indicator-bar'
        });
      });
      for (const [color, paths] of histogramShapes)
        add('path', { d: paths.join(''), fill: color, class: 'indicator-bar' });
      if (fiveDay) indicatorData.lines.forEach((s) => drawSeries(s, iy, 'indicator-line'));
      else
        lines.forEach((s) => {
          const points = s.values
            .map((value, i) => (isFiniteNumber(value) ? `${x(bars[i], i)},${iy(value)}` : null))
            .filter(Boolean);
          if (points.length === 1) {
            const [cx, cy] = points[0]!.split(',');
            add('circle', { cx, cy, r: 2, fill: s.color });
          } else if (points.length)
            add('polyline', {
              points: points.join(' '),
              fill: 'none',
              stroke: s.color,
              'stroke-width': 1.5,
              class: 'indicator-line'
            });
        });
      if (!values.length)
        add('text', { x: (L + R) / 2, y: (I + IB) / 2, 'text-anchor': 'middle' }, '数据不足，等待更多周期');
    }
    const indicatorCross = withIndicator
      ? add('line', { x1: L, x2: L, y1: I, y2: IB, class: 'crosshair', visibility: 'hidden' })
      : null;
    target = fragment;
    if (fiveDay)
      for (let i = 1; i < data.dates.length; i++)
        add('line', {
          x1: L + (i * width) / data.dates.length,
          x2: L + (i * width) / data.dates.length,
          y1: T,
          y2: bottom,
          class: 'grid'
        });
    ticks.forEach(([xx, text]) => add('text', { x: xx, y: bottom + 22, 'text-anchor': 'middle' }, text));
    const cross = add('line', { x1: L, x2: L, y1: T, y2: bottom, class: 'crosshair', visibility: 'hidden' });
    const marker = add('circle', { cx: L, cy: T, r: 3, fill: lineColor, visibility: 'hidden' });
    svg.replaceChildren(fragment);
    indicatorSvg.replaceChildren(indicatorFragment);
    $('plot').setAttribute(
      'aria-label',
      `${data.name} ${names[mode]}图，${bars[0].time} 至 ${bars.at(-1)!.time}，最新价格 ${price(bars.at(-1)!.close)}${withIndicator ? '，副图 ' + indicatorData!.label : ''}。可用左右方向键查看数据。`
    );
    $('indicator-note').textContent = !withIndicator
      ? ''
      : isIntraday(mode)
        ? '指标按当日分钟采样价格计算并每日重置；KDJ使用采样价范围，不代表完整1分钟K线高低价。'
        : `指标按${names[mode]}全量已获取记录计算后截取显示范围；不同历史长度及初始化方式可能产生数值差异。`;
    const selected =
      hover?.active && (candles || fiveDay || hover.date === data.date)
        ? bars.findIndex((b) => b.time === hover!.bars[hover!.index].time)
        : -1;
    const side = hover?.side || 'right',
      panel = hover?.panel || 'main';
    hover = {
      bars,
      x,
      y,
      cross,
      indicatorCross,
      marker,
      L,
      R,
      start,
      index: bars.length - 1,
      date: data.date,
      active: false,
      side,
      panel
    };
    if (selected >= 0) pointAt(selected);
    else {
      $('chart-tooltip').hidden = true;
      detail(bars.at(-1)!, start + bars.length - 1);
    }
  }
  const numberOrDash = (value) => (isFiniteNumber(value) ? value.toFixed(4) : '—');
  function renderDetails(time, groups) {
    const title = document.createElement('div');
    title.className = 'detail-time';
    title.textContent = time;
    const grid = document.createElement('div');
    grid.className = 'detail-grid';
    for (const group of groups) {
      const column = document.createElement('div');
      column.className = 'detail-column';
      for (const [name, value, direction] of group) {
        const row = document.createElement('div');
        row.className = 'detail-row';
        const label = document.createElement('span');
        label.className = 'detail-label';
        label.textContent = name + ' ';
        const number = document.createElement('span');
        number.className = 'detail-value' + (direction > 0 ? ' rising' : direction < 0 ? ' falling' : '');
        number.textContent = value;
        row.append(label, number);
        column.append(row);
      }
      grid.append(column);
    }
    $('detail').replaceChildren(title, grid);
  }
  function detail(bar: PriceBar, index: number) {
    if (!data) return;
    const time = mode === 'intraday' ? `${data.date} ${bar.time.slice(0, 2)}:${bar.time.slice(2)}` : bar.time;
    const previous =
      mode === 'intraday' ? data.previousClose : mode === 'intraday5' ? bar.previousClose : data.bars[index - 1]?.close;
    // Historical/weekly/monthly bars must use their preceding bar, not today's quote.
    const delta = isFiniteNumber(previous) && previous > 0 ? bar.close - previous : null;
    const change = delta === null ? null : (delta / previous!) * 100;
    const amplitude = delta === null ? null : ((bar.high - bar.low) / previous!) * 100;
    const changes = `涨跌 ${signed(delta, precision)}　涨跌幅 ${signed(change)}%`;
    const mainAverages = averages.map((a) => `${a.name} ${priceOrDash(a.values[index])}`);
    const volumeValues = volumeAverages.map(
      (a) => `${a.name} ${isFiniteNumber(a.values[index]) ? volume(a.values[index]) : '—'}`
    );
    const indicatorText = (item) =>
      `${item.label}　${item.lines.map((s) => `${s.name} ${numberOrDash(s.values[index])}`).join('　')}${item.histogram ? '　柱 ' + numberOrDash(item.histogram[index]) : ''}`;
    const historicalRate = isFiniteNumber(bar.historicalTurnover) ? bar.historicalTurnover.toFixed(2) + '%' : '—';
    const missingReason =
      data.historicalStatus === 'loading'
        ? '获取中'
        : data.historicalStatus === 'error'
          ? '获取失败，可刷新重试'
          : '该时间暂无数据';
    const turnover =
      data.turnoverApplicable && mode !== 'intraday'
        ? `${mode === 'intraday5' ? (bar.date === data.date ? '当日换手率（最新）' : '当日换手率（全天）') : '换手率'} ${historicalRate}`
        : '';
    for (const { label, series, format } of legend)
      label.textContent = `${series.name} ${format(series.values[index])}`;
    const direction = (value) =>
      isFiniteNumber(previous) && previous > 0 && isFiniteNumber(value) ? value - previous : 0;
    const selectedDate = mode === 'intraday5' ? bar.date : data.date;
    const sameQuoteDay =
      /^\d{14}$/.test(data.dailyQuoteTimestamp || '') &&
      (data.dailyQuoteTimestamp || '').slice(0, 8) === String(selectedDate || '').replaceAll('-', '');
    const dailyHigh = sameQuoteDay ? data.dailyHigh : null,
      dailyLow = sameQuoteDay ? data.dailyLow : null;
    const turnLabel =
      mode === 'intraday5' ? (bar.date === data.date ? '当日换手率（最新）' : '当日换手率（全天）') : '换手率';
    const groups = !isIntraday(mode)
      ? [
          [
            ['开', price(bar.open), direction(bar.open)],
            ['收', price(bar.close), direction(bar.close)]
          ],
          [
            ['高', price(bar.high), direction(bar.high)],
            ['低', price(bar.low), direction(bar.low)]
          ],
          [
            ['涨跌幅', percent(change), change],
            ['涨跌', signed(delta, precision), delta]
          ],
          [
            ['换手率', historicalRate],
            ['振幅', percent(amplitude)]
          ],
          [
            ['成交量', volume(bar.volume)],
            ['前收', priceOrDash(previous)]
          ]
        ]
      : [
          [
            ['价格', price(bar.close), direction(bar.close)],
            ['均价', priceOrDash(bar.averagePrice)]
          ],
          [
            ['高', priceOrDash(dailyHigh), direction(dailyHigh)],
            ['低', priceOrDash(dailyLow), direction(dailyLow)]
          ],
          [
            ['涨跌幅', percent(change), change],
            ['涨跌', signed(delta, precision), delta]
          ],
          [
            ['分钟成交量', volume(bar.volume)],
            ['累计成交量', isFiniteNumber(bar.cumulativeVolume) ? volume(bar.cumulativeVolume) : '—']
          ],
          [
            ['分钟成交额', amount(bar.amount)],
            ['累计成交额', amount(bar.cumulativeAmount)]
          ],
          ...(turnover ? [[[turnLabel, historicalRate]]] : [])
        ];
    if (!isIntraday(mode) && !data.turnoverApplicable) groups[3].shift();
    renderDetails(time, groups);
    $('average-detail').textContent = [...mainAverages, ...volumeValues].join('　');
    $('indicator-detail').textContent = !indicatorData ? '' : indicatorText(indicatorData);
    const rows = isIntraday(mode)
      ? [
          time,
          `价格 ${price(bar.close)}　均价 ${priceOrDash(bar.averagePrice)}`,
          changes,
          `日高 ${priceOrDash(dailyHigh)}　日低 ${priceOrDash(dailyLow)}`,
          `分钟量 ${volume(bar.volume)}　累计量 ${isFiniteNumber(bar.cumulativeVolume) ? volume(bar.cumulativeVolume) : '—'}`,
          `分钟额 ${amount(bar.amount)}　累计额 ${amount(bar.cumulativeAmount)}`
        ]
      : [
          time,
          `开 ${price(bar.open)}　收 ${price(bar.close)}`,
          `高 ${price(bar.high)}　低 ${price(bar.low)}`,
          changes,
          `振幅 ${signed(amplitude)}%　量 ${volume(bar.volume)}`,
          mainAverages.slice(0, 3).join('　'),
          mainAverages.slice(3).join('　'),
          volumeValues.join('　')
        ];
    $('chart-tooltip').textContent = [
      ...rows,
      ...(turnover ? [turnover + (historicalRate === '—' ? `（${missingReason}）` : '')] : []),
      ...Object.values(metrics).map(indicatorText)
    ].join('\n');
  }
  function pointAt(index) {
    if (!hover) return;
    hover.index = Math.max(0, Math.min(hover.bars.length - 1, index));
    hover.active = true;
    const bar = hover!.bars[hover!.index],
      xx = hover!.x(bar, hover.index);
    hover.cross.setAttribute('x1', String(xx));
    hover.cross.setAttribute('x2', String(xx));
    hover.cross.setAttribute('visibility', 'visible');
    detail(bar, hover.start + hover.index);
    if (hover.indicatorCross) {
      hover.indicatorCross.setAttribute('x1', String(xx));
      hover.indicatorCross.setAttribute('x2', String(xx));
      hover.indicatorCross.setAttribute('visibility', 'visible');
    }
    hover.marker.setAttribute('cx', String(xx));
    hover.marker.setAttribute('cy', String(hover.y(bar.close)));
    hover.marker.setAttribute('visibility', 'visible');
    $('chart-tooltip').hidden = false;
    $('chart-tooltip').style.top =
      hover.panel === 'indicator' && indicator !== 'none' ? `${$('indicator-chart').offsetTop + 32}px` : '38px';
    $('chart-tooltip').style.left = hover.side === 'left' ? '12px' : 'auto';
    $('chart-tooltip').style.right = hover.side === 'right' ? '12px' : 'auto';
  }
  $('plot').addEventListener('pointermove', (event) => {
    if (!hover) return;
    const fromIndicator =
      event.target === $('indicator-svg') || (event.target as SVGElement)?.ownerSVGElement === $('indicator-svg');
    // Buttons and reading notes are not part of the data hit area.
    if (
      event.target !== $('plot') &&
      !fromIndicator &&
      event.target !== $('svg') &&
      (event.target as SVGElement)?.ownerSVGElement !== $('svg')
    )
      return;
    hover.panel = fromIndicator ? 'indicator' : 'main';
    const transform = $(fromIndicator ? 'indicator-svg' : 'svg').getScreenCTM();
    if (!transform) return;
    const xx = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse()).x;
    hover.side = xx > (hover.L + hover.R) / 2 ? 'left' : 'right';
    let best = 0;
    hover.bars.forEach((bar, i) => {
      if (Math.abs(hover!.x(bar, i) - xx) < Math.abs(hover!.x(hover!.bars[best], best) - xx)) best = i;
    });
    pointAt(best);
  });
  function resetSelection() {
    if (!hover) return;
    hover.active = false;
    draw();
  }
  $('plot').addEventListener('pointerleave', resetSelection);
  $('plot').addEventListener('blur', (event) => {
    if (!indicatorButtons.includes(event.relatedTarget as HTMLButtonElement)) resetSelection();
  });
  $('plot').addEventListener('keydown', (event) => {
    if (indicatorButtons.includes(event.target as HTMLButtonElement)) return;
    if (event.key === 'Escape') {
      resetSelection();
      return;
    }
    if (hover && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      pointAt(hover.index + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.token !== token) return;
    if (message.type === 'select-indicator' && ['macd', 'kdj', 'rsi', 'none'].includes(message.indicator)) {
      indicator = message.indicator;
      updateIndicatorControls();
      draw();
      return;
    }
    if (message.type === 'select-mode') {
      setMode(message.mode);
      return;
    }
    if (message.mode && message.mode !== mode) return;
    if (message.type === 'history-state') {
      historyBusy = Boolean(message.busy);
      $('history-progress').textContent = message.message || '';
      if (!historyBusy) {
        pendingRange = null;
        pendingEnd = null;
      }
      updateZoom();
      return;
    }
    if (message.type === 'refresh' && isWebMode(mode)) {
      loadWeb(true);
      return;
    }
    if (message.type === 'loading') {
      $('status').className = '';
      $('status').textContent = message.preserve ? '正在刷新，图表保留上次成功数据…' : '正在获取行情数据…';
    }
    if (message.type === 'error') {
      $('status').className = 'error';
      $('status').textContent =
        `${message.message}${message.preserve ? '；保留上次成功数据，等待下次刷新。' : '。可重试或在浏览器打开。'}`;
      if (data) renderEtfReference($('etf-reference'), data, Date.now(), true);
    }
    if (message.type === 'data' && message.data?.mode === mode && message.data.symbol === symbol) {
      const firstData = !data;
      data = { ...message.data, dates: message.data.dates || [] } as ChartData;
      if (data.historyReset) {
        windowEnd = null;
        pendingEnd = null;
        fitHistory = false;
        pendingRange = null;
        hover = null;
        $('history-progress').textContent = '复权价格已更新，请重新加载更早历史。';
      }
      if (pendingEnd && data.bars[0].time < pendingEnd) {
        windowEnd = pendingEnd;
        pendingEnd = null;
      }
      if (fitHistory) range = Math.max(30, data.bars.length);
      else if (pendingRange !== null) range = Math.max(30, Math.min(pendingRange, data.bars.length));
      else if (!isIntraday(mode) && (firstData || data.historyReset))
        range = Math.max(30, Math.min(range, data.bars.length));
      renderEtfReference($('etf-reference'), data, Date.now());
      updateZoom();
      $('status').className = '';
      $('status').textContent = '';
      $('history-status').textContent =
        !data.turnoverApplicable || mode === 'intraday'
          ? ''
          : data.historicalStatus === 'loading'
            ? '历史换手率获取中…'
            : data.historicalStatus === 'error'
              ? `${data.historicalError || '历史换手率获取失败'}；可点击右上角刷新重试。`
              : data.historicalStatus === 'ready' || data.historicalStatus === 'stale'
                ? `历史换手率：${data.historicalSource || '行情源'}${data.historicalStatus === 'stale' ? '（接口失败，使用缓存）' : ''}${data.historicalFetchedAt ? ` · 获取时间 ${data.historicalFetchedAt}（北京）` : ''}；未覆盖的时间显示“—”。`
                : '';
      $('meta').textContent =
        `${data.source} · ${names[mode]} · ${isIntraday(mode) ? '分钟采样' : data.adjustment} · ${mode === 'intraday5' ? `交易日 ${data.dates.length} 天 · ` : ''}数据日期 ${data.date}${data.timestamp ? ` · 报价时间 ${clock(data.timestamp)}` : ''}（北京）${data.klineFetchedAt ? ' · 历史获取 ' + new Date(data.klineFetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : ''}${data.klineWarning ? ' · ' + data.klineWarning : ''}`;
      const last = data.bars.at(-1)!.close,
        delta = data.previousClose ? (last / data.previousClose - 1) * 100 : null;
      $('quote').textContent =
        `${data.name} · ${symbol}　${price(last)}${delta === null || !isIntraday(mode) ? '' : `  ${delta >= 0 ? '▲ +' : '▼ '}${delta.toFixed(2)}%`}`;
      $('quote').style.color = delta === null || !isIntraday(mode) ? '' : delta >= 0 ? up : down;
      $('turnover').textContent = data.turnoverApplicable
        ? `最新换手率 ${isFiniteNumber(data.turnoverRate) ? data.turnoverRate.toFixed(2) + '%' : '—'}${data.turnoverTimestamp ? `（${clock(data.turnoverTimestamp)} 北京）` : ''}`
        : '';
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
