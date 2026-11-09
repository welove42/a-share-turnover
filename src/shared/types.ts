/** 主进程和 Webview 共用的数据合同，不包含 VS Code 或浏览器依赖。 */
export type NullableNumber = number | null;
export type Log = (message: string) => void;
export type AsyncSource<T> = (signal?: AbortSignal) => Promise<T>;

/** ETF 折溢价只使用同一报价快照；行情时间不代表 IOPV 的独立更新时间。 */
export interface EtfQuote {
  symbol: string;
  price: NullableNumber;
  iopv: NullableNumber;
  premiumRate: NullableNumber;
  quoteTimestamp: string | null;
  timestampMs: NullableNumber;
  source: string;
  notice: string;
}

/** 行情缺失使用 null，不能用 0 冒充停牌、无数据或无涨跌。 */
export interface StockQuote {
  symbol: string;
  name: string;
  price: NullableNumber;
  priceText: string;
  previousClose: NullableNumber;
  delta: NullableNumber;
  percent: NullableNumber;
  date: string;
  timestamp: string;
  high: NullableNumber;
  low: NullableNumber;
  turnoverRate: NullableNumber;
  etf?: EtfQuote;
  source?: string;
  cached?: boolean;
}
export interface QuoteBatch<T = StockQuote> {
  quotes: Map<string, T>;
  errors: Map<string, string>;
}
export interface MinutePoint {
  time: string;
  amount: number;
}
export interface MarketBreadth {
  advancing: number;
  declining: number;
  unchanged: number;
}
export interface MarketQuote {
  symbol: string;
  date: string;
  timestamp: string;
  amount: number;
  points: MinutePoint[];
  breadth: MarketBreadth | null;
  percent: NullableNumber;
}
export interface HistoryDay {
  date: string;
  points: MinutePoint[];
}
export interface AmountChange {
  current: number;
  previous: number;
  delta: number;
  percent: number;
}
/** 成交额内部统一用元；展示层才转换为亿元。时间采用北京时间。 */
export interface TurnoverSnapshot {
  version: number;
  date: string;
  fetchedAt: string;
  amount: number;
  markets: Array<Pick<MarketQuote, 'symbol' | 'amount' | 'timestamp' | 'breadth' | 'percent'>>;
  previousDate: string | null;
  sameTime: AmountChange | null;
  previousDay: AmountChange | null;
  comparisonTime: string | null;
  warning: string;
}
export interface PriceBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  date?: string;
  dayIndex?: number;
  previousClose?: NullableNumber;
  cumulativeVolume?: number;
  cumulativeAmount?: NullableNumber;
  averagePrice?: NullableNumber;
  historicalTurnover?: NullableNumber;
  amount?: NullableNumber;
  turnoverRate?: NullableNumber;
  average?: NullableNumber;
}
export type IndicatorName = 'macd' | 'kdj' | 'rsi' | 'none';
export interface IndicatorLine {
  name: string;
  color: string;
  values: NullableNumber[];
}
export interface IndicatorSeries {
  label: string;
  lines: IndicatorLine[];
  histogram?: number[];
  levels: number[];
  bounds?: number[];
}
export interface TemperaturePoint {
  time: string;
  score: number;
}
export interface GlobalIndexEntry {
  id: string;
  code: string;
  name: string;
  region: string;
}
export interface GlobalQuote extends GlobalIndexEntry {
  price: number;
  percent: NullableNumber;
  delta: NullableNumber;
  open: NullableNumber;
  high: NullableNumber;
  low: NullableNumber;
  previousClose: NullableNumber;
  timestamp: number;
  source?: 'eastmoney' | 'sina';
  timestampKind?: 'quote' | 'updated';
}
export interface CommodityEntry {
  code: string;
  name: string;
  unit: string;
  aliases: string;
}
export interface CommodityQuote {
  code: string;
  price: number;
  priceText: string;
  previousClose: NullableNumber;
  delta: NullableNumber;
  percent: NullableNumber;
  open: NullableNumber;
  high: NullableNumber;
  low: NullableNumber;
  date: string;
  time: string;
  timestamp: number;
}
export interface NewsArticle {
  key: string;
  id: string;
  source: string;
  title: string;
  body: string;
  publishedAt: number;
  stocks: string;
}
export interface StockGroup {
  id: string;
  name: string;
  symbols: string[];
}
