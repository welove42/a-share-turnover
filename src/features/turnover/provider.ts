import { requestJson, requestQuoteText } from '../../core/network/http';
import { parseMinute, parseMarketQuote, parseHistory, buildSnapshot, turnoverSession, timeToMinute } from './market';
import type { MarketQuote } from '../../shared/types';
import { MinuteFeed } from './minute-feed';
const SYMBOLS = ['sh000002', 'sz399107'];
const ROOT = 'https://web.ifzq.gtimg.cn/appstock/app';

// Wait for both exchanges to settle before returning errors, preventing orphaned requests.
async function pair(operation) {
  const results = await Promise.allSettled(SYMBOLS.map(operation));
  const errors = results.filter((result) => result.status === 'rejected');
  if (errors.length) throw new Error(errors.map((result) => result.reason?.message || '行情请求失败').join('；'));
  return results.map((result) => (result as PromiseFulfilledResult<any>).value);
}

class MarketProvider {
  declare request: typeof requestJson;
  declare log: (message: string) => void;
  declare now: () => Date;
  declare minuteFeed: MinuteFeed;
  declare quoteRequest: typeof requestQuoteText;
  declare histories: never[][];
  declare historyDate: string;
  declare historyAttempt: number;

  constructor({
    request = requestJson,
    quoteRequest = requestQuoteText,
    log = (_message: string) => {},
    now = () => new Date()
  } = {}) {
    this.request = request;
    this.log = log;
    this.now = now;
    this.minuteFeed = new MinuteFeed(request, () => this.now().getTime());
    this.quoteRequest = quoteRequest;
    this.histories = [[], []];
    this.historyDate = '';
    this.historyAttempt = 0;
  }

  async load(signal, forceHistory = false) {
    const clock = turnoverSession(this.now());
    if (clock.phase === 'opening') return this.loadOpening(signal, clock);
    const markets = await pair(async (symbol) =>
      parseMinute((await this.minuteFeed.load(symbol, signal)).payload, symbol)
    );
    if (signal?.aborted) throw new Error('行情请求已取消');
    if (markets[0].date !== markets[1].date) throw new Error('沪深行情日期不一致，等待两市更新');
    const date = markets[0].date;
    const needsHistory = this.historyDate !== date;
    const now = this.now();
    // Retry a missing baseline at most once per minute; real-time values still update every 10s.
    if (forceHistory || (needsHistory && now.getTime() - this.historyAttempt >= 60000)) {
      this.historyAttempt = now.getTime();
      try {
        const histories = await pair(async (symbol) =>
          parseHistory(await this.request(`${ROOT}/day/query?code=${symbol}`, signal), symbol)
        );
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

  private async loadOpening(signal: AbortSignal | undefined, clock: ReturnType<typeof turnoverSession>) {
    if (signal?.aborted) throw new Error('行情请求已取消');
    const validate = (markets: MarketQuote[]) => {
      if (
        markets.some((market) => {
          const minute = timeToMinute(market.timestamp.slice(8, 12));
          return market.date !== clock.date || minute < 565 || minute > clock.minute;
        })
      )
        throw new Error('等待两市更新今日09:25后的开盘成交额');
      return markets;
    };
    let markets: MarketQuote[];
    try {
      // 盘前只发一次批量实时报价请求，不反复获取尚未就绪的分钟曲线和历史基准。
      const text = await this.quoteRequest(`https://qt.gtimg.cn/q=${SYMBOLS.join(',')}`, signal);
      const quotes = new Map<string, string[]>();
      for (const match of text.matchAll(/v_((?:sh|sz)\d{6})="([^"\r\n]*)"\s*;?/g))
        if (SYMBOLS.includes(match[1])) quotes.set(match[1], match[2].split('~'));
      markets = validate(SYMBOLS.map((symbol) => parseMarketQuote(quotes.get(symbol), symbol)));
    } catch (error) {
      if (signal?.aborted) throw new Error('行情请求已取消');
      this.log(`开盘实时报价暂不可用，尝试分时接口中的实时报价：${error.message}`);
      markets = validate(
        await pair(async (symbol) => {
          const payload = (await this.minuteFeed.load(symbol, signal)).payload;
          if (payload.code !== 0) throw new Error(`${symbol}行情接口返回异常`);
          return parseMarketQuote(payload.data?.[symbol]?.qt?.[symbol], symbol);
        })
      );
    }
    if (signal?.aborted) throw new Error('行情请求已取消');
    const snapshot = buildSnapshot(markets, [[], []], this.now());
    snapshot.warning = '已更新今日开盘撮合后的累计成交额；09:30前分钟基准尚未就绪，暂不计算昨日同刻缩放量';
    return snapshot;
  }
}

export { SYMBOLS, requestJson, MarketProvider };
