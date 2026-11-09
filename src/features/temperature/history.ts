import { validDate, shanghaiClock } from '../turnover/market';
import { seconds, SAMPLE_SECONDS } from '../../shared/temperature-model';
const KEY = 'temperatureHistory',
  LIMIT = 300;
const PHASES = ['交易中', '午休', '收盘确认', '已收盘'];
function validPoint(point, date) {
  if (
    !point ||
    !Number.isInteger(point.score) ||
    point.score < 0 ||
    point.score > 100 ||
    seconds(point.time) === null ||
    !PHASES.includes(point.phase) ||
    typeof point.sampledAt !== 'string' ||
    !Number.isFinite(Date.parse(point.sampledAt))
  )
    return false;
  const clock = shanghaiClock(new Date(point.sampledAt));
  return clock.date === date && clock.time === point.time && (seconds(point.time) ?? NaN) >= 9.5 * 3600;
}
function inSession(point): boolean {
  const time = seconds(point.time) ?? -1;
  return point.phase === '交易中'
    ? (time >= 34200 && time < 41400) || (time >= 46800 && time < 54000)
    : point.phase === '收盘确认' && time >= 54000 && time < 54120;
}
function restore(value, date) {
  if (
    ![1, 2].includes(value?.version) ||
    value.model !== 1 ||
    value.date !== date ||
    !validDate(date) ||
    !Array.isArray(value.points) ||
    value.points.length > (value.version === 1 ? 9000 : LIMIT)
  )
    return [];
  let bucket = -1;
  for (const point of value.points) {
    const next = Math.floor((seconds(point?.time) ?? NaN) / (value.version === 1 ? 10 : SAMPLE_SECONDS));
    if (!validPoint(point, date) || next <= bucket) return [];
    bucket = next;
  }
  // Migrate 10-second history to minute samples without inventing values or losing the day's record.
  const minutes = new Map<number, any>();
  for (const { time, score, sampledAt, phase } of value.points) {
    const point = { time, score, sampledAt, phase };
    if (inSession(point)) minutes.set(Math.floor(Math.min(seconds(time)!, 54000) / SAMPLE_SECONDS), point);
  }
  return [...minutes.values()].slice(-LIMIT);
}
class TemperatureHistory {
  declare storage: any;
  declare date: any;
  declare log: (message: string) => void;
  declare queue: Promise<void>;
  declare points: any;

  constructor(storage, date, log = (_message: string) => {}) {
    this.storage = storage;
    this.date = date;
    this.log = log;
    this.queue = Promise.resolve();
    const saved = storage.get(KEY);
    this.points = restore(saved, date);
    if (saved?.version === 1 && saved.model === 1 && saved.date === date) this.save();
  }
  rollover(date) {
    if (!validDate(date) || date <= this.date) return false;
    this.date = date;
    this.points = [];
    this.save();
    return true;
  }
  record(result, sampledAt) {
    if (result?.score === null || !validDate(result?.date)) return false;
    if (typeof sampledAt !== 'string' || !Number.isFinite(Date.parse(sampledAt))) return false;
    const clock = shanghaiClock(new Date(sampledAt));
    if (clock.date !== this.date || result.date !== this.date) return false;
    const point = { time: clock.time, score: result.score, sampledAt, phase: result.phase };
    if (!validPoint(point, this.date) || !inSession(point)) return false;
    const previous = this.points.at(-1),
      bucket = Math.floor((seconds(point.time) ?? NaN) / SAMPLE_SECONDS),
      priorBucket = previous ? Math.floor((seconds(previous.time) ?? NaN) / SAMPLE_SECONDS) : -1;
    if (bucket <= priorBucket || (previous && Date.parse(point.sampledAt) < Date.parse(previous.sampledAt)))
      return false;
    // Keep one closing endpoint; post-close manual refreshes must not stretch the day into the evening.
    const replaceClose = previous?.phase === '收盘确认' && point.phase === '收盘确认';
    this.points = [...(replaceClose ? this.points.slice(0, -1) : this.points), point].slice(-LIMIT);
    this.save();
    return true;
  }
  save() {
    const value = { version: 2, model: 1, date: this.date, points: this.points.map((point) => ({ ...point })) };
    // Serialize writes so a slower prior-day save cannot overwrite today's data.
    this.queue = this.queue
      .then(() => this.storage.update(KEY, value))
      .catch((error) => this.log(`温度记录保存失败：${error.message}`));
  }
  flush() {
    return this.queue;
  }
  data() {
    return { date: this.date, points: this.points.map((point) => ({ ...point })) };
  }
}
export { TemperatureHistory, restore, validPoint };
