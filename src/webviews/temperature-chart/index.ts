import type { TemperaturePoint } from '../../shared/types';
interface TemperatureData {
  date: string;
  points: (TemperaturePoint & { phase?: string })[];
  phase: string;
  current: { score: number | null; label: string; reason?: string };
}
interface TemperaturePlot {
  x: (point: { time: string }) => number;
  y: (score: number) => number;
  L: number;
  R: number;
  begin: number;
  end: number;
  cross: SVGElement;
  marker: SVGElement;
  index: number;
}
import { elements, isFiniteNumber } from '../shared/dom';
interface PageElements {
  date: HTMLElement;
  status: HTMLElement;
  current: HTMLElement;
  summary: HTMLElement;
  'temperature-plot': HTMLElement;
  'temperature-svg': SVGSVGElement;
  'temperature-tooltip': HTMLElement;
  'temperature-detail': HTMLElement;
}
import * as temperatureModel from '../../shared/temperature-model';
('use strict');
(() => {
  const vscode = acquireVsCodeApi(),
    $ = elements<PageElements>(),
    token = document.body.dataset.token;
  const { label, seconds, segments, nearest, crossesLunch, SAMPLE_SECONDS, PLOT_END } = temperatureModel;
  const ns = 'http://www.w3.org/2000/svg',
    colors = ['ice', 'cold', 'neutral', 'warm', 'hot'];
  let data: TemperatureData | null = null,
    plot: TemperaturePlot | null = null,
    selectedBucket: number | null = null,
    side = 'right';
  const phase = (point) => (point.phase === '午休' ? '午休快照' : point.phase === '已收盘' ? '收盘快照' : point.phase);
  const level = (score) =>
    score < 20 ? 'coldest' : score < 40 ? 'cold' : score < 60 ? '' : score < 80 ? 'warm' : 'hot';
  function draw() {
    if (!data) return;
    const points = data.points,
      svg = $('temperature-svg');
    const W = Math.max(400, svg.clientWidth || 1000),
      H = Math.max(320, svg.clientHeight || 440);
    const L = 48,
      R = W - 24,
      T = 34,
      B = H - 46,
      begin = 34200;
    const end = PLOT_END;
    const x = (point) => L + ((Math.min(end, seconds(point.time) ?? NaN) - begin) / (end - begin)) * (R - L),
      y = (score) => B - (score / 100) * (B - T);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const fragment = document.createDocumentFragment();
    const add = (tag: string, attrs: Record<string, unknown>, text?: string | number) => {
      const item = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
      if (text !== undefined) item.textContent = String(text);
      fragment.append(item);
      return item;
    };
    for (let i = 0; i < 5; i++)
      add('rect', {
        x: L,
        y: y((i + 1) * 20),
        width: R - L,
        height: (B - T) / 5,
        fill: `var(--temperature-${colors[i]})`,
        class: 'temperature-band'
      });
    const lunchStart = x({ time: '11:30:00' }),
      lunchEnd = x({ time: '13:00:00' });
    add('rect', { x: lunchStart, y: T, width: lunchEnd - lunchStart, height: B - T, class: 'lunch' });
    add('text', { x: (lunchStart + lunchEnd) / 2, y: T - 12, 'text-anchor': 'middle' }, '午休');
    for (let score = 0; score <= 100; score += 20) {
      add('line', { x1: L, x2: R, y1: y(score), y2: y(score), class: 'grid' });
      add('text', { x: L - 10, y: y(score) + 4, 'text-anchor': 'end' }, score);
    }
    const ticks = ['09:30:00', '10:30:00', '11:30:00', '13:00:00', '14:00:00', '15:00:00'];
    if (end > 54000)
      ticks.push(
        `${String(Math.floor(end / 3600)).padStart(2, '0')}:${String(Math.floor(end / 60) % 60).padStart(2, '0')}:00`
      );
    ticks.forEach((time) => add('text', { x: x({ time }), y: B + 26, 'text-anchor': 'middle' }, time.slice(0, 5)));
    const groups = segments(points);
    for (const [index, segment] of groups.entries()) {
      if (index) {
        const previous = groups[index - 1].at(-1)!;
        if (!crossesLunch(previous, segment[0]))
          add('polyline', {
            points: [previous, segment[0]].map((p) => `${x(p)},${y(p.score)}`).join(' '),
            class: 'temperature-line temperature-gap'
          });
      }
      if (segment.length === 1)
        add('circle', {
          cx: x(segment[0]),
          cy: y(segment[0].score),
          r: 3,
          fill: 'var(--temperature-line)',
          class: 'temperature-point'
        });
      else
        add('polyline', { points: segment.map((p) => `${x(p)},${y(p.score)}`).join(' '), class: 'temperature-line' });
    }
    if (points.length)
      add('circle', { cx: x(points.at(-1)), cy: y(points.at(-1)!.score), r: 4, fill: 'var(--temperature-line)' });
    else {
      add('text', { x: (L + R) / 2, y: (T + B) / 2 - 8, 'text-anchor': 'middle' }, '当天暂无已采集的温度记录');
      add(
        'text',
        { x: (L + R) / 2, y: (T + B) / 2 + 18, 'text-anchor': 'middle' },
        '盘中每分钟记录一次，启用前的时段留空'
      );
    }
    const cross = add('line', { x1: L, x2: L, y1: T, y2: B, class: 'crosshair', visibility: 'hidden' });
    const marker = add('circle', { cx: L, cy: T, r: 5, fill: 'var(--temperature-line)', visibility: 'hidden' });
    svg.replaceChildren(fragment);
    plot = { x, y, L, R, begin, end, cross, marker, index: points.length - 1 };
    const selected =
      selectedBucket === null
        ? -1
        : points.findIndex((p) => Math.floor((seconds(p.time) ?? NaN) / SAMPLE_SECONDS) === selectedBucket);
    if (selected >= 0) inspect(selected);
    else reset();
    $('temperature-plot').setAttribute(
      'aria-label',
      `市场温度 ${data.date}，${points.length}个采集点。${points.length ? `最近记录${points.at(-1)!.time}，${points.at(-1)!.score}分，${label(points.at(-1)!.score)}。` : '暂无记录。'}可按左右方向键查看。`
    );
  }
  function describe(point) {
    return `${data!.date} ${point.time}（北京采集时间）　温度 ${point.score}/100 · ${label(point.score)}　${phase(point)}`;
  }
  function inspect(index) {
    if (!plot || !data || !data.points.length) return;
    plot.index = Math.max(0, Math.min(data.points.length - 1, index));
    const point = data.points[plot.index],
      xx = plot.x(point);
    selectedBucket = Math.floor((seconds(point.time) ?? NaN) / SAMPLE_SECONDS);
    plot.cross.setAttribute('x1', String(xx));
    plot.cross.setAttribute('x2', String(xx));
    plot.cross.setAttribute('visibility', 'visible');
    plot.marker.setAttribute('cx', String(xx));
    plot.marker.setAttribute('cy', String(plot.y(point.score)));
    plot.marker.setAttribute('visibility', 'visible');
    $('temperature-tooltip').textContent =
      `${data.date} ${point.time}\n温度 ${point.score} / 100 · ${label(point.score)}\n${phase(point)} · 北京采集时间`;
    $('temperature-tooltip').hidden = false;
    $('temperature-tooltip').style.left = side === 'left' ? '14px' : 'auto';
    $('temperature-tooltip').style.right = side === 'right' ? '14px' : 'auto';
    $('temperature-detail').textContent = describe(point);
  }
  function reset() {
    selectedBucket = null;
    if (!plot || !data) return;
    plot.index = data.points.length - 1;
    plot.cross.setAttribute('visibility', 'hidden');
    plot.marker.setAttribute('visibility', 'hidden');
    $('temperature-tooltip').hidden = true;
    $('temperature-detail').textContent = data.points.length
      ? `最近记录：${describe(data.points.at(-1))}`
      : '暂无记录；不会将缺失数据补成0分。';
  }
  $('temperature-plot').addEventListener('pointermove', (event) => {
    if (!plot || !data || !data.points.length) return;
    const matrix = $('temperature-svg').getScreenCTM();
    if (!matrix) return;
    const xx = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()).x;
    side = xx > (plot.L + plot.R) / 2 ? 'left' : 'right';
    inspect(nearest(data.points, plot.begin + ((xx - plot.L) / (plot.R - plot.L)) * (plot.end - plot.begin)));
  });
  $('temperature-plot').addEventListener('pointerleave', reset);
  $('temperature-plot').addEventListener('blur', reset);
  $('temperature-plot').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') reset();
    if (plot && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      inspect(plot.index + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (
      message?.token !== token ||
      message.type !== 'temperature-data' ||
      !message.data ||
      !Array.isArray(message.data.points) ||
      message.data.points.length > 9000
    )
      return;
    const next = message.data;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(next.date) ||
      !next.current ||
      !next.points.every(
        (p, i) =>
          seconds(p.time) !== null &&
          Number.isInteger(p.score) &&
          p.score >= 0 &&
          p.score <= 100 &&
          (!i || (seconds(p.time) ?? NaN) > (seconds(next.points[i - 1].time) ?? NaN))
      )
    )
      return;
    if (data?.date !== next.date) selectedBucket = null;
    data = next as TemperatureData;
    $('date').textContent = data.date;
    $('current').textContent =
      data.current.score === null ? data.current.label : `${data.current.score} ${data.current.label}`;
    $('current').className = data.current.score === null ? '' : level(data.current.score);
    $('status').textContent = data.current.reason || `${data.phase} · 0–100分自定义情绪指标 · 盘中每分钟记录`;
    $('summary').replaceChildren();
    if (data.points.length) {
      const latest = data.points.at(-1),
        scores = data.points.map((p) => p.score);
      for (const text of [
        `最近 ${latest!.time} · ${latest!.score}分`,
        `当日最高 ${Math.max(...scores)}分`,
        `当日最低 ${Math.min(...scores)}分`,
        `已采集 ${data.points.length}点`
      ]) {
        const item = document.createElement('span');
        item.textContent = text;
        $('summary').append(item);
      }
    } else $('summary').textContent = '曲线从功能启用后开始记录，重启可续接当天数据。';
    draw();
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe($('temperature-plot'));
  vscode.postMessage({ action: 'ready', token });
})();
