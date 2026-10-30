'use strict';
const vscode = require('vscode');
const privateUI = require('./privacy-ui');
const LEGACY_ID = 'local-market-tools.a-share-turnover';
async function warnLegacy(context) {
  if (!vscode.extensions.getExtension(LEGACY_ID) || context.globalState.get('legacyWarningShown')) return;
  await context.globalState.update('legacyWarningShown', true);
  if (privateUI.isHidden()) return;
  const choice = await vscode.window.showWarningMessage('检测到旧版 A股行情（local-market-tools）。请禁用或卸载旧版并重新加载窗口，避免重复侧栏和状态栏。新版支持中文名搜索，窗口标题为“搜索并添加自选股”。', '查看旧版扩展');
  if (choice && !privateUI.isHidden()) await vscode.commands.executeCommand('workbench.extensions.search', '@id:' + LEGACY_ID);
}
module.exports = { LEGACY_ID, warnLegacy };
