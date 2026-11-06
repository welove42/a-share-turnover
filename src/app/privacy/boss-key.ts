import * as vscode from 'vscode';
import * as privateUI from '../../core/ui/privacy';

class BossKey {
  declare context: any;
  declare controller: any;
  declare stocks: any;
  declare news: any;
  declare charts: any;
  declare globals: any;
  declare funds: any;
  declare commodities: any;
  declare sectors: any;
  declare reminders: any;
  declare settings: any;
  declare alerts: any;
  declare ai: any;
  declare hidden: boolean;
  declare since: any;
  declare write: Promise<void>;
  declare contextWrite: any;

  constructor(
    context,
    { controller, stocks, news, charts, globals, funds, commodities, sectors, reminders, settings, alerts, ai }
  ) {
    this.context = context;
    this.controller = controller;
    this.stocks = stocks;
    this.news = news;
    this.charts = charts;
    this.globals = globals;
    this.funds = funds;
    this.commodities = commodities;
    this.sectors = sectors;
    this.reminders = reminders;
    this.settings = settings;
    this.alerts = alerts;
    this.ai = ai;
    this.hidden = Boolean(context.globalState.get('bossKeyHidden', false));
    const saved = context.globalState.get('bossKeyHiddenSince');
    this.since = Number.isFinite(saved) ? saved : Date.now();
    this.write = Promise.resolve();
    this.contextWrite = Promise.resolve();
    privateUI.setHidden(this.hidden);
    if (this.hidden) this.apply(true);
    else this.setViewsVisible(true);
  }
  setViewsVisible(visible) {
    // Serialize updates: a slow earlier toggle must not overwrite the final state.
    this.contextWrite = this.contextWrite
      .catch(() => {})
      .then(() => vscode.commands.executeCommand('setContext', 'aShareTurnover.hidden', !visible));
    return this.contextWrite;
  }
  apply(hidden, since?: number) {
    privateUI.setHidden(hidden);
    this.settings?.setHidden(hidden);
    this.alerts?.setHidden(hidden);
    this.ai?.setHidden(hidden);
    for (const item of [
      this.controller,
      this.stocks,
      this.news,
      this.charts,
      this.globals,
      this.funds,
      this.commodities,
      this.sectors
    ])
      item.setHidden(hidden);
    this.reminders.setHidden(hidden, since);
    const contextWrite = this.setViewsVisible(!hidden);
    if (hidden) {
      // Close only the extension's own virtual news documents, not user files.
      const groups = vscode.window.tabGroups;
      const tabs =
        groups?.all.flatMap((group) =>
          group.tabs.filter((tab) => (tab.input as { uri?: vscode.Uri } | undefined)?.uri?.scheme === 'a-share-news')
        ) || [];
      if (tabs.length) void Promise.resolve(groups.close(tabs, true)).catch(() => {});
    }
    return contextWrite;
  }
  toggle() {
    const next = !this.hidden,
      since = next ? Date.now() : this.since;
    this.hidden = next;
    if (next) this.since = since;
    const contextWrite = this.apply(next, since);
    // Serialize rapid toggles so an earlier write cannot overwrite the final state.
    this.write = this.write
      .catch(() => {})
      .then(async () => {
        await this.context.globalState.update('bossKeyHiddenSince', next ? since : undefined);
        await this.context.globalState.update('bossKeyHidden', next);
      });
    return Promise.all([this.write, contextWrite]);
  }
  dispose() {
    privateUI.setHidden(false);
  }
}
export { BossKey };
