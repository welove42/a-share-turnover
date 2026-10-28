'use strict';

const { requestJson } = require('./http');
const { parseMinute, parseHistory, buildSnapshot } = require('./market');
const { MinuteFeed } = require('./minute-feed');
const SYMBOLS = ['sh000002', 'sz399107'];
const ROOT = 'https://web.ifzq.gtimg.cn/appstock/app';

// Wait for both exchanges to settle before returning errors, preventing orphaned requests.
async function pair(operation) {
  const results = await Promise.allSettled(SYMBOLS.map(operation));
  const errors = results.filter(result => result.status === 'rejected');
  if (errors.length) throw new Error(errors.map(result => result.reason?.message || '行情请求失败').join('；'));
  return results.map(result => result.value);
}

class MarketProvider {
  constructor({ request = requestJson, log = () => {}, now = () => new Date() } = {}) {
    this.request = request;
    this.log = log;
    this.now = now;
    this.minuteFeed = new MinuteFeed(request, () => this.now().getTime());
    this.histories = [[], []];
    this.historyDate = '';
    this.historyAttempt = 0;
  }

  async load(signal, forceHistory = false) {
    const markets = await pair(async symbol => parseMinute(
      (await this.minuteFeed.load(symbol, signal)).payload, symbol));
    if (signal?.aborted) throw new Error('行情请求已取消');
    if (markets[0].date !== markets[1].date) throw new Error('沪深行情日期不一致，等待两市更新');
    const date = markets[0].date;
    const needsHistory = this.historyDate !== date;
    const now = this.now();
    // Retry a missing baseline at most once per minute; real-time values still update every 10s.
    if (forceHistory || (needsHistory && now.getTime() - this.historyAttempt >= 60000)) {
      this.historyAttempt = now.getTime();
      try {
        const histories = await pair(async symbol => parseHistory(
          await this.request(`${ROOT}/day/query?code=${symbol}`, signal), symbol));
        const trial = buildSnapshot(markets, histories, now);
        this.histories = histories;
        if (trial.previousDay) this.historyDate = date;
      } catch (error) {
        this.log(`历史分时获取失败：${error.message}`);
      }
    }
    if (signal?.aborted) throw new Error('行情请求已取消');
    // Old-day cache is never used as a new day's previous-trading-day baseline.
    const histories = this.historyDate === date ? this.histories : [[], []];
    return buildSnapshot(markets, histories, this.now());
  }
}

module.exports = { SYMBOLS, requestJson, MarketProvider };
