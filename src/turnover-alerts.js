'use strict';
const { timeToMinute, tradingMinute, validDate } = require('./market');
const KEY = 'turnoverAlertDays';

// Both coloring and notifications use the displayed comparison and its actual data time.
function turnoverSignal(snapshot, state, config, clock, now) {
  if (!snapshot || state.paused || state.cached || state.error || snapshot.date !== clock.date
    || !['trading', 'settling', 'lunch', 'after'].includes(clock.phase)) return null;
  const age = now.getTime() - Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || clock.polling && age > 90000) return null;
  const recentMinute = minute => ((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900))
    && minute <= clock.minute && tradingMinute(clock.minute) - tradingMinute(minute) <= 2;
  try {
    if (!Array.isArray(snapshot.markets) || snapshot.markets.length !== 2 || snapshot.markets.some(m =>
      !/^\d{14}$/.test(m.timestamp || '') || m.timestamp.slice(0, 8) !== clock.date.replaceAll('-', '')
      || Number(m.timestamp.slice(12, 14)) > 59 || !recentMinute(timeToMinute(m.timestamp.slice(8, 12))))) return null;
  } catch { return null; }
  const mode = config.comparisonMode === 'previousDay' ? 'previousDay' : 'sameTime', value = snapshot[mode];
  if (!value || !Number.isFinite(value.percent) || !Number.isFinite(value.previous) || value.previous <= 0
    || !validDate(snapshot.previousDate) || snapshot.previousDate >= snapshot.date) return null;
  if (mode === 'sameTime') {
    try { if (!/^\d{2}:\d{2}$/.test(snapshot.comparisonTime || '') || !recentMinute(timeToMinute(snapshot.comparisonTime.replace(':', '')))) return null; }
    catch { return null; }
  }
  const configured = config.turnoverAlerts?.percent;
  const threshold = Number.isFinite(configured) && configured >= 1 && configured <= 100 ? configured : 20;
  if (Math.abs(value.percent) <= threshold) return null;
  const direction = value.percent > 0 ? 'up' : 'down';
  return { direction, percent: Math.abs(value.percent), threshold, date: snapshot.date, mode,
    label: direction === 'up' ? '放量' : '缩量', color: direction === 'up' ? 'charts.red' : 'charts.green',
    basis: mode === 'sameTime' ? `上一交易日同刻 ${snapshot.comparisonTime}` : '上一交易日全天' };
}

class TurnoverAlerts {
  constructor(storage, notify, log = () => {}) {
    this.storage = storage; this.notify = notify; this.log = log; this.write = Promise.resolve();
    const saved = storage.get(KEY, {});
    this.sent = Object.fromEntries(['up', 'down'].filter(k => validDate(saved?.[k])).map(k => [k, saved[k]]));
  }
  check(snapshot, state, config, clock, now) {
    if (!config.enabled || !config.turnoverAlerts?.enabled || !clock.polling) return;
    const signal = turnoverSignal(snapshot, state, config, clock, now);
    if (!signal || this.sent[signal.direction] === signal.date) return;
    this.sent[signal.direction] = signal.date;
    const saved = { ...this.sent };
    this.write = this.write.then(() => this.storage.update(KEY, saved)).catch(e => this.log(`成交额提醒记录保存失败：${e.message}`));
    const text = `大盘成交额提醒：沪深 A 股较${signal.basis}${signal.label} ${signal.percent.toFixed(2)}%，超过 ${signal.threshold}% 阈值。当前累计 ${(snapshot.amount / 1e8).toFixed(2)} 亿元。`;
    try { void Promise.resolve(this.notify(text)).catch(e => this.log(`成交额提醒显示失败：${e.message}`)); }
    catch (e) { this.log(`成交额提醒显示失败：${e.message}`); }
  }
}
module.exports = { turnoverSignal, TurnoverAlerts };
