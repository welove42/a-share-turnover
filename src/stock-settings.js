'use strict';
const vscode = require('vscode');
const KEY = 'stockSettingsFallback';

// An older installed manifest or a temporarily read-only settings file must not
// prevent adding stocks. Keep a persistent fallback until that setting can be saved.
class StockSettings {
  constructor(context, log = () => {}) { this.context = context; this.log = log; }
  get(key, fallback) {
    const local = this.context.globalState.get(KEY, {});
    return Object.hasOwn(local, key) ? local[key] : vscode.workspace.getConfiguration('aShareTurnover').get(key, fallback);
  }
  async set(key, value) {
    const settings = vscode.workspace.getConfiguration('aShareTurnover');
    try {
      await settings.update(key, value, vscode.ConfigurationTarget.Global);
      const local = { ...this.context.globalState.get(KEY, {}) };
      if (Object.hasOwn(local, key)) { delete local[key]; await this.context.globalState.update(KEY, local); }
    } catch {
      await this.context.globalState.update(KEY, { ...this.context.globalState.get(KEY, {}), [key]: value });
      this.log('自选股设置暂时无法写入 settings.json，已保存到插件持久存储，重新加载后仍可使用。');
    }
  }
}
module.exports = { StockSettings };
