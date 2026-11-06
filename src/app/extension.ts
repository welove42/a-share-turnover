/** 扩展入口：创建各功能、注册命令并统一回收资源；业务规则放在 features。 */
import { TurnoverController } from '../features/turnover/controller';
import * as vscode from 'vscode';
import { WatchlistController } from '../features/watchlist/controller';
import { NewsController } from '../features/news/controller';
import { ChartController } from '../features/charts/controller';
import { GlobalIndicesController } from '../features/global-indices/controller';
import { FundsController } from '../features/funds/controller';
import { CommoditiesController } from '../features/commodities/controller';
import { entryFor as commodityEntry } from '../features/commodities/data';
import { warnLegacy } from './legacy';
import { SectorsController } from '../features/sectors/controller';
import { ReminderController } from '../features/reminders/controller';
import { BossKey } from './privacy/boss-key';
import { DebugCoverProvider } from './privacy/debug-cover';
import { SettingsController } from '../features/settings/controller';
import { StockAlerts } from '../features/watchlist/alerts';
import { AiAnalysisController } from '../features/ai/controller';

function activate(context) {
  const controller = new TurnoverController(context);
  const stocks = new WatchlistController(context, { log: (message) => controller.log(message) });
  controller.riskSource = () => {
    const quote = stocks.quotes.get('sh000001');
    return quote ? { ...quote, stale: !stocks.config.enabled || stocks.paused || stocks.stale('sh000001') } : null;
  };
  const news = new NewsController(context, { log: (message) => controller.log(message) });
  const charts = new ChartController(context, {
    selected: () => stocks.config.selected,
    name: (symbol) => stocks.quotes.get(symbol)?.name
  });
  const globals = new GlobalIndicesController(context, { log: (message) => controller.log(message) });
  const funds = new FundsController(context, { log: (message) => controller.log(message) });
  const commodities = new CommoditiesController(context, { log: (message) => controller.log(message) });
  const sectors = new SectorsController(context);
  const reminders = new ReminderController(context);
  const alerts = new StockAlerts(context, stocks);
  const ai = new AiAnalysisController(context, {
    stocks,
    market: controller,
    globals,
    commodities,
    news,
    openSettings: () => settings.open('ai')
  });
  const settings = new SettingsController(context, {
    stocks,
    ai,
    sources: [stocks, globals, funds, commodities],
    lists: {
      'stocks.symbols': {
        ids: () => stocks.config.symbols,
        name: (id) => stocks.quotes.get(id)?.name || (id === 'sh000001' ? '上证指数' : ''),
        add: () => stocks.searchAndAdd('', 'a'),
        remove: (id) => stocks.remove(id)
      },
      'stocks.hkSymbols': {
        ids: () => stocks.overseas.symbols.hk,
        name: (id) => stocks.overseas.quotes.get(id)?.name,
        add: () => stocks.overseas.add({ market: 'hk' }),
        remove: (id) => stocks.overseas.remove(stocks.overseas.element(id))
      },
      'stocks.usSymbols': {
        ids: () => stocks.overseas.symbols.us,
        name: (id) => stocks.overseas.quotes.get(id)?.name,
        add: () => stocks.overseas.add({ market: 'us' }),
        remove: (id) => stocks.overseas.remove(stocks.overseas.element(id))
      },
      'globalIndices.symbols': {
        ids: () => globals.selectedIds,
        name: (id) => globals.catalog.get(id)?.name,
        add: () => globals.add(),
        remove: (id) => globals.remove(id)
      },
      'funds.symbols': {
        ids: () => funds.symbols,
        name: (id) => funds.quotes.get(id)?.name,
        add: () => funds.add(),
        remove: (id) => funds.remove(id),
        edit: (id) => funds.editHolding(id)
      },
      'commodities.symbols': {
        ids: () => commodities.codes,
        name: (id) => commodityEntry(id)?.name,
        add: () => commodities.add(),
        remove: (id) => commodities.remove(id)
      }
    }
  });
  const bossKey = new BossKey(context, {
    controller,
    stocks,
    news,
    charts,
    globals,
    funds,
    commodities,
    sectors,
    reminders,
    settings,
    alerts,
    ai
  });
  const bind = (command, callback) =>
    vscode.commands.registerCommand(command, (...args) => (bossKey.hidden ? undefined : callback(...args)));
  context.subscriptions.push(
    controller,
    bossKey,
    vscode.commands.registerCommand('welove42.aShareTurnover.toggleHidden', () => bossKey.toggle()),
    vscode.window.registerWebviewViewProvider('welove42.aShareTurnover.debugCover', new DebugCoverProvider()),
    bind('welove42.aShareTurnover.refresh', () => controller.refresh(true)),
    bind('welove42.aShareTurnover.showMenu', () => controller.showMenu()),
    bind('welove42.aShareTurnover.togglePause', () => controller.togglePause()),
    bind('welove42.aShareTurnover.switchComparison', () => controller.switchComparison()),
    bind('welove42.aShareTurnover.showLog', () => controller.output.show()),
    bind('welove42.aShareTurnover.showTemperature', () => controller.showTemperature()),
    bind('welove42.aShareTurnover.showTemperatureDetails', () => controller.showTemperatureDetails()),
    bind('welove42.aShareTurnover.temperature.refresh', () => controller.refresh(true)),
    bind('welove42.aShareTurnover.sectors.refresh', () => sectors.retry()),
    bind('welove42.aShareTurnover.sectors.menu', () => sectors.showMenu()),
    bind('welove42.aShareTurnover.reminders.show', () => reminders.show()),
    stocks,
    news,
    charts,
    globals,
    funds,
    commodities,
    sectors,
    reminders,
    settings,
    alerts,
    ai,
    bind('welove42.aShareTurnover.ai.open', (element) => ai.open(element)),
    bind('welove42.aShareTurnover.ai.market', () => ai.open('market')),
    bind('welove42.aShareTurnover.ai.chart', () => ai.open(charts.visibleState()?.symbol)),
    bind('welove42.aShareTurnover.settings.open', () => settings.open()),
    bind('welove42.aShareTurnover.commodities.add', (input) => commodities.add(input)),
    bind('welove42.aShareTurnover.commodities.remove', (element) => commodities.remove(element)),
    bind('welove42.aShareTurnover.commodities.refresh', () => commodities.refresh()),
    bind('welove42.aShareTurnover.commodities.togglePause', () => commodities.togglePause()),
    bind('welove42.aShareTurnover.commodities.open', (element) => commodities.open(element)),
    bind('welove42.aShareTurnover.funds.add', (input) => funds.add(input)),
    bind('welove42.aShareTurnover.funds.remove', (element) => funds.remove(element)),
    bind('welove42.aShareTurnover.funds.refresh', () => funds.refresh()),
    bind('welove42.aShareTurnover.funds.togglePause', () => funds.togglePause()),
    bind('welove42.aShareTurnover.funds.editHolding', (element) => funds.editHolding(element)),
    bind('welove42.aShareTurnover.funds.clearHolding', (element) => funds.clearHolding(element)),
    bind('welove42.aShareTurnover.funds.open', (element) => funds.open(element)),
    bind('welove42.aShareTurnover.globalIndices.search', () => globals.search()),
    bind('welove42.aShareTurnover.globalIndices.add', (input) => globals.add(input)),
    bind('welove42.aShareTurnover.globalIndices.remove', (element) => globals.remove(element)),
    bind('welove42.aShareTurnover.globalIndices.refresh', () => globals.refresh()),
    bind('welove42.aShareTurnover.globalIndices.togglePause', () => globals.togglePause()),
    bind('welove42.aShareTurnover.globalIndices.open', (element) => globals.open(element)),
    bind('welove42.aShareTurnover.stocks.openChart', (element, mode) => charts.open(element, mode)),
    bind('welove42.aShareTurnover.stocks.openInBrowser', (element) => charts.openExternal(element)),
    bind('welove42.aShareTurnover.chart.selectMode', () => charts.chooseMode()),
    bind('welove42.aShareTurnover.chart.selectIndicator', () => charts.chooseIndicator()),
    bind('welove42.aShareTurnover.chart.refresh', () => charts.refreshActive()),
    bind('welove42.aShareTurnover.chart.openInBrowser', () => charts.openActiveExternal()),
    bind('welove42.aShareTurnover.stocks.add', (input) => stocks.add(input)),
    bind('welove42.aShareTurnover.stockGroups.create', (element) => stocks.groupCommand('create', element)),
    bind('welove42.aShareTurnover.stockGroups.rename', (element) => stocks.groupCommand('rename', element)),
    bind('welove42.aShareTurnover.stockGroups.remove', (element) => stocks.groupCommand('remove', element)),
    bind('welove42.aShareTurnover.stockGroups.move', (element) => stocks.groupCommand('move', element)),
    bind('welove42.aShareTurnover.stockGroups.add', (element) => stocks.groupCommand('add', element)),
    bind('welove42.aShareTurnover.stocks.remove', (element) => stocks.remove(element)),
    bind('welove42.aShareTurnover.stocks.refresh', () =>
      Promise.all([stocks.refresh(), stocks.overseas.refreshAll(true)])
    ),
    bind('welove42.aShareTurnover.overseas.add', (element) => stocks.overseas.add(element)),
    bind('welove42.aShareTurnover.overseas.remove', (element) => stocks.overseas.remove(element)),
    bind('welove42.aShareTurnover.overseas.open', (element) => stocks.overseas.open(element)),
    bind('welove42.aShareTurnover.overseas.selectSession', () => stocks.overseas.chooseUsSession()),
    bind('welove42.aShareTurnover.stocks.selectStatus', (element) => stocks.selectStatus(element)),
    bind('welove42.aShareTurnover.stocks.sort', () => stocks.sort()),
    bind('welove42.aShareTurnover.stocks.togglePause', () => stocks.togglePause()),
    bind('welove42.aShareTurnover.news.refresh', () => news.refresh()),
    bind('welove42.aShareTurnover.news.show', () => news.show()),
    bind('welove42.aShareTurnover.news.open', (item) => news.open(item)),
    bind('welove42.aShareTurnover.news.togglePause', () => news.togglePause())
  );
  controller.start();
  stocks.start();
  news.start();
  globals.start();
  funds.start();
  commodities.start();
  sectors.start();
  reminders.start();
  alerts.start();
  if (!bossKey.hidden) void warnLegacy(context).catch((error) => controller.log('旧版检测：' + error.message));
  return {
    getWatchlist: () => [...stocks.config.symbols],
    getSelectedSymbol: () => stocks.config.selected,
    getMarketTemperature: () => (controller.temperatureResult ? { ...controller.temperatureResult } : undefined),
    getMarketTemperatureHistory: () => controller.temperatureHistory.data(),
    getStockSearchState: () =>
      stocks.activePicker
        ? {
            title: stocks.activePicker.title,
            query: stocks.activePicker.value,
            busy: stocks.activePicker.busy,
            candidates: stocks.activePicker.items
              .filter((item) => item.symbols)
              .map((item) => ({ name: item.label, symbols: [...item.symbols!] }))
          }
        : undefined,
    getStockQuote: (symbol) => {
      const q = stocks.quotes.get(symbol);
      return q ? { ...q } : undefined;
    },
    getNewsCount: () => news.items.length,
    getChartState: (symbol) => charts.getState(symbol),
    getGlobalIndices: () =>
      globals.selectedIds.map((id) => ({
        ...globals.catalog.get(id),
        quote: globals.quotes.get(id),
        error: globals.errors.get(id)
      })),
    getGlobalIndicesStatus: () => ({
      enabled: globals.enabled,
      visible: globals.tree.visible,
      paused: globals.paused,
      lastAttempt: globals.lastAttempt,
      retryIntervalMs: globals.pollDelay
    }),
    getFunds: () =>
      funds.symbols.map((code) => ({
        code,
        quote: funds.quotes.get(code),
        error: funds.errors.get(code),
        hasHolding: Boolean(funds.holdings[code])
      })),
    getFundsStatus: () => ({
      enabled: funds.enabled,
      visible: funds.tree.visible,
      paused: funds.paused,
      lastAttempt: funds.lastAttempt
    }),
    getCommodities: () =>
      commodities.codes.map((code) => ({
        code,
        quote: commodities.quotes.get(code),
        error: commodities.errors.get(code)
      })),
    getCommoditiesStatus: () => ({
      enabled: commodities.enabled,
      visible: commodities.tree.visible,
      paused: commodities.paused,
      lastAttempt: commodities.lastAttempt
    }),
    getLatestNews: () => (news.items[0] ? { ...news.items[0] } : undefined)
  };
}

export { activate, TurnoverController };
