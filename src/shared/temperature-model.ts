import type { TemperaturePoint } from './types';
function label(score: number): string {
  return score < 20 ? '冰点' : score < 40 ? '偏冷' : score < 60 ? '中性' : score < 80 ? '偏热' : '过热';
}
function seconds(time: unknown): number | null {
  if (typeof time !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return null;
  const [h, m, s] = time.split(':').map(Number);
  return h < 24 && m < 60 && s < 60 ? h * 3600 + m * 60 + s : null;
}
function segments(points: TemperaturePoint[]): TemperaturePoint[][] {
  const result: TemperaturePoint[][] = [];
  points.forEach((point, i) => {
    if (!i || (seconds(point.time) ?? 0) - (seconds(points[i - 1].time) ?? 0) > 60) result.push([]);
    result.at(-1)!.push(point);
  });
  return result;
}
function nearest(points: TemperaturePoint[], value: number): number {
  if (!points.length) return -1;
  let lo = 0,
    hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((seconds(points[mid].time) ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 &&
    Math.abs((seconds(points[lo - 1].time) ?? 0) - value) <= Math.abs((seconds(points[lo].time) ?? 0) - value)
    ? lo - 1
    : lo;
}
export { label, seconds, segments, nearest };
