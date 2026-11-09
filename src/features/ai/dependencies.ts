import type * as vscode from 'vscode';
import type { WatchlistController } from '../watchlist/controller';
import type { TurnoverController } from '../turnover/controller';
import type { GlobalIndicesController } from '../global-indices/controller';
import type { CommoditiesController } from '../commodities/controller';
import type { NewsController } from '../news/controller';
import type { ChartProvider } from '../charts/data';
import type { AiQuoteProvider } from './quote-data';
import type { AnalysisEnvironment } from './environment';
import type { MarketProvider } from '../turnover/provider';
import type { GlobalIndexProvider } from '../global-indices/data';
import type { CommodityProvider } from '../commodities/data';
import type { NewsProvider } from '../news/data';
import type { AiSectorProvider } from './sector-data';
import type { complete } from './client';
import type { listModels } from './models';
import type { AiHistoryProvider } from './history-data';
import type { AiConfiguration, AnalysisSnapshot } from './types';

/** 使用已有行情控制器作为缓存来源；不把它们的持仓或密钥传给 AI。 */
export interface ContextSources {
  stocks?: Pick<WatchlistController, 'quotes' | 'config'>;
  market?: Pick<TurnoverController, 'snapshot' | 'state' | 'config'>;
  globals?: Pick<GlobalIndicesController, 'selectedIds' | 'quotes'>;
  commodities?: Pick<CommoditiesController, 'quotes'>;
  news?: Pick<NewsController, 'items'>;
}
export interface ContextDependencies extends ContextSources {
  chartProvider?: ChartProvider;
  quoteProvider?: AiQuoteProvider;
  now?: () => Date;
  environment?: AnalysisEnvironment;
  historyProvider?: AiHistoryProvider;
}
export interface EnvironmentDependencies extends ContextSources {
  now?: () => Date;
  marketProvider?: MarketProvider;
  globalProvider?: GlobalIndexProvider;
  commodityProvider?: CommodityProvider;
  newsProvider?: NewsProvider;
  sectorProvider?: AiSectorProvider;
  timeoutMs?: number;
}
export interface AnalysisDependencies extends ContextSources {
  collect?: (target: string, signal?: AbortSignal) => Promise<AnalysisSnapshot>;
  request?: typeof complete;
  requestModels?: typeof listModels;
  config?: () => AiConfiguration;
  openSettings?: () => void;
}
export type ExtensionContext = vscode.ExtensionContext;
