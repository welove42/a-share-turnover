'use strict';
const { timeToMinute } = require('./market');
function marketRisk(snapshot, state, quote, clock, now, options = {}) {
  if (options.enabled === false || !snapshot?.sameTime || !snapshot.comparisonTime || !quote || state.paused || state.cached || state.error || quote.stale || snapshot.date !== clock.date || quote.date !== snapshot.date || !['trading', 'settling', 'lunch', 'after'].includes(clock.phase)) return null;
  if (clock.polling && now.getTime() - Date.parse(snapshot.fetchedAt) > 90000) return null;
  if (!Number.isFinite(snapshot.sameTime.percent) || !Number.isFinite(quote.percent) || !/^\d{14}$/.test(quote.timestamp || '')) return null;
  let comparison, quoteMinute;
  try { comparison = timeToMinute(snapshot.comparisonTime.replace(':', '')); quoteMinute = timeToMinute(quote.timestamp.slice(8, 12)); }
  catch { return null; }
  if (Math.abs(comparison - quoteMinute) > 2) return null;
  const volumeLimit = Number.isFinite(options.volumePercent) && options.volumePercent > 0 ? options.volumePercent : 30;
  const dropLimit = Number.isFinite(options.dropPercent) && options.dropPercent > 0 ? options.dropPercent : 1.5;
  if (quote.percent > -dropLimit || Math.abs(snapshot.sameTime.percent) < volumeLimit) return null;
  return { label: snapshot.sameTime.percent > 0 ? '放量下跌' : '缩量下跌', volume: snapshot.sameTime.percent, change: quote.percent, volumeLimit, dropLimit, comparisonTime: snapshot.comparisonTime };
}
module.exports = { marketRisk };
