'use strict';
const { validDate, shanghaiClock } = require('./market');
const { seconds } = require('../media/temperature-model');
const KEY = 'temperatureHistory', LIMIT = 9000;
const PHASES = ['交易中', '午休', '收盘确认', '已收盘'];
function validPoint(point, date) {
  if (!point || !Number.isInteger(point.score) || point.score < 0 || point.score > 100 || seconds(point.time) === null
    || !PHASES.includes(point.phase) || typeof point.sampledAt !== 'string' || !Number.isFinite(Date.parse(point.sampledAt))) return false;
  const clock = shanghaiClock(new Date(point.sampledAt));
  return clock.date === date && clock.time === point.time && seconds(point.time) >= 9.5 * 3600;
}
function restore(value, date) {
  if (value?.version !== 1 || value.model !== 1 || value.date !== date || !validDate(date) || !Array.isArray(value.points) || value.points.length > LIMIT) return [];
  let bucket = -1;
  for (const point of value.points) {
    const next = Math.floor(seconds(point?.time) / 10);
    if (!validPoint(point, date) || next <= bucket) return [];
    bucket = next;
  }
  return value.points.map(({ time, score, sampledAt, phase }) => ({ time, score, sampledAt, phase }));
}
class TemperatureHistory {
  constructor(storage, date, log = () => {}) {
    this.storage = storage; this.date = date; this.log = log; this.queue = Promise.resolve();
    this.points = restore(storage.get(KEY), date);
  }
  rollover(date) {
    if (!validDate(date) || date <= this.date) return false;
    this.date = date; this.points = []; this.save(); return true;
  }
  record(result, sampledAt) {
    if (result?.score === null || !validDate(result?.date)) return false;
    if (typeof sampledAt !== 'string' || !Number.isFinite(Date.parse(sampledAt))) return false;
    const clock = shanghaiClock(new Date(sampledAt));
    if (clock.date !== this.date || result.date !== this.date) return false;
    const point = { time: clock.time, score: result.score, sampledAt, phase: result.phase };
    if (!validPoint(point, this.date)) return false;
    const previous = this.points.at(-1), bucket = Math.floor(seconds(point.time) / 10), priorBucket = previous ? Math.floor(seconds(previous.time) / 10) : -1;
    if (bucket < priorBucket || (previous && Date.parse(point.sampledAt) < Date.parse(previous.sampledAt))) return false;
    if (previous && JSON.stringify(previous) === JSON.stringify(point)) return false;
    this.points = [...(bucket === priorBucket ? this.points.slice(0, -1) : this.points), point].slice(-LIMIT);
    this.save(); return true;
  }
  save() {
    const value = { version: 1, model: 1, date: this.date, points: this.points.map(point => ({ ...point })) };
    // Serialize writes so a slower prior-day save cannot overwrite today's data.
    this.queue = this.queue.then(() => this.storage.update(KEY, value)).catch(error => this.log(`温度记录保存失败：${error.message}`));
  }
  flush() { return this.queue; }
  data() { return { date: this.date, points: this.points.map(point => ({ ...point })) }; }
}
module.exports = { TemperatureHistory, restore, validPoint };
