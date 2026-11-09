import type { TemperaturePoint } from './types';
function label(score: number): string {
  return score < 20 ? '冰点' : score < 40 ? '偏冷' : score < 60 ? '中性' : score < 80 ? '偏热' : '过热';
}
function seconds(time: unknown): number | null {
  if (typeof time !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return null;
  const [h, m, s] = time.split(':').map(Number);
  return h < 24 && m < 60 && s < 60 ? h * 3600 + m * 60 + s : null;
}
const SAMPLE_SECONDS = 60;
const PLOT_END = 15 * 3600;
function crossesLunch(a: TemperaturePoint, b: TemperaturePoint): boolean {
  return (seconds(a.time) ?? 0) <= 11.5 * 3600 && (seconds(b.time) ?? 0) >= 13 * 3600;
}
function segments(points: TemperaturePoint[]): TemperaturePoint[][] {
  const result: TemperaturePoint[][] = [];
  points.forEach((point, i) => {
    if (
      !i ||
      crossesLunch(points[i - 1], point) ||
      (seconds(point.time) ?? 0) - (seconds(points[i - 1].time) ?? 0) > 180
    )
      result.push([]);
    result.at(-1)!.push(point);
  });
  return result;
}
function nearest(points: TemperaturePoint[], value: number): number {
  if (!points.length) return -1;
  // A close-confirmation sample retains its real time but is drawn at the 15:00 boundary.
  const at = (index: number) => Math.min(PLOT_END, seconds(points[index].time) ?? 0);
  let lo = 0,
    hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(at(lo - 1) - value) <= Math.abs(at(lo) - value) ? lo - 1 : lo;
}
export { label, seconds, segments, nearest, crossesLunch, SAMPLE_SECONDS, PLOT_END };
