import * as vscode from 'vscode';
import { StockSettings } from '../watchlist/settings';
import { DEFAULT_COMMODITY_CODES, isCommodityQuote, isFuturesCode, normalizeCommodityCodes } from '../commodities/data';

const MIGRATED = 'futuresSeparatedV1';
/** Write the destination first; an interrupted upgrade can retry without losing the user's selection. */
async function migrateFutures(context: vscode.ExtensionContext, log = (_message: string) => {}): Promise<void> {
  if (context.globalState.get(MIGRATED)) return;
  const settings = new StockSettings(context, log);
  try {
    const old = normalizeCommodityCodes(settings.get('commodities.symbols', DEFAULT_COMMODITY_CODES));
    const moved = old.filter(isFuturesCode);
    if (moved.length) {
      const config = vscode.workspace.getConfiguration('aShareTurnover');
      const explicit = (key: string) => {
        const local = context.globalState.get<Record<string, unknown>>('stockSettingsFallback', {});
        const inspected = config.inspect?.(key);
        return (
          Object.hasOwn(local, key) ||
          (inspected
            ? [inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue].some(
                (value) => value !== undefined
              )
            : config.get(key) !== undefined)
        );
      };
      const existing = explicit('futures.symbols') ? normalizeCommodityCodes(settings.get('futures.symbols', [])) : [];
      await settings.set('futures.symbols', [...new Set([...existing.filter(isFuturesCode), ...moved])]);
      if (!explicit('futures.enabled')) await settings.set('futures.enabled', config.get('commodities.enabled', true));
      if (context.globalState.get('futuresPaused') === undefined)
        await context.globalState.update('futuresPaused', Boolean(context.globalState.get('commoditiesPaused', false)));
      const merged = new Map();
      for (const key of ['commodityQuotes', 'futuresQuotes']) {
        const quotes = context.globalState.get<unknown>(key, []);
        if (!Array.isArray(quotes)) continue;
        for (const q of quotes)
          if (
            isCommodityQuote(q) &&
            isFuturesCode(q.code) &&
            (!merged.has(q.code) || q.timestamp >= merged.get(q.code).timestamp)
          )
            merged.set(q.code, q);
      }
      await context.globalState.update('futuresQuotes', [...merged.values()]);
      await settings.set(
        'commodities.symbols',
        old.filter((code) => !isFuturesCode(code))
      );
    }
    await context.globalState.update(MIGRATED, true);
  } catch {
    log('期货列表迁移未完成，保留原配置，下次启动重试。');
  }
}
export { migrateFutures };
