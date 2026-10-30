'use strict';
const vscode = require('vscode');
const privateUI = require('./privacy-ui');

class BossKey {
  constructor(context, { controller, stocks, news, charts, globals, funds, commodities, sectors, reminders }) {
    this.context=context; this.controller=controller; this.stocks=stocks; this.news=news; this.charts=charts;
    this.globals=globals; this.funds=funds; this.commodities=commodities; this.sectors=sectors; this.reminders=reminders;
    this.hidden=Boolean(context.globalState.get('bossKeyHidden',false));
    const saved=context.globalState.get('bossKeyHiddenSince');
    this.since=Number.isFinite(saved) ? saved : Date.now();
    this.write=Promise.resolve();
    privateUI.setHidden(this.hidden);
    if (this.hidden) this.apply(true);
    else void vscode.commands.executeCommand('setContext','aShareTurnover.visible',true);
  }
  apply(hidden, since) {
    const wasVisible=[this.stocks.tree,this.globals.tree,this.funds.tree,this.commodities.tree].some(tree=>tree.visible);
    privateUI.setHidden(hidden);
    for (const item of [this.controller,this.stocks,this.news,this.charts,this.globals,this.funds,this.commodities,this.sectors]) item.setHidden(hidden);
    this.reminders.setHidden(hidden,since);
    void vscode.commands.executeCommand('setContext','aShareTurnover.visible',!hidden);
    if (hidden) {
      if (wasVisible) void vscode.commands.executeCommand('workbench.view.explorer');
      // Close only the extension's own virtual news documents, not user files.
      const groups=vscode.window.tabGroups;
      const tabs=groups?.all.flatMap(group=>group.tabs.filter(tab=>tab.input?.uri?.scheme==='a-share-news')) || [];
      if(tabs.length) void Promise.resolve(groups.close(tabs,true)).catch(()=>{});
    }
  }
  toggle() {
    const next=!this.hidden, since=next ? Date.now() : this.since;
    this.hidden=next; if(next) this.since=since;
    this.apply(next,since);
    // Serialize rapid toggles so an earlier write cannot overwrite the final state.
    this.write=this.write.catch(()=>{}).then(async()=>{
      await this.context.globalState.update('bossKeyHiddenSince',next ? since : undefined);
      await this.context.globalState.update('bossKeyHidden',next);
    });
    return this.write;
  }
  dispose() { privateUI.setHidden(false); }
}
module.exports = { BossKey };
