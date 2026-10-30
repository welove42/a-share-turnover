'use strict';
const vscode = require('vscode');
let hidden = false;
const pending = new Set();
function setHidden(value) {
  hidden = Boolean(value);
  if (hidden) for (const token of pending) token.cancel();
}
async function request(method, args) {
  if (hidden) return undefined;
  const source = new vscode.CancellationTokenSource(); pending.add(source);
  try { const result = await vscode.window[method](...args, source.token); return hidden || source.token.isCancellationRequested ? undefined : result; }
  finally { pending.delete(source); source.dispose(); }
}
function showQuickPick(items, options) { return request('showQuickPick', [items, options]); }
function showInputBox(options) { return request('showInputBox', [options]); }
function showErrorMessage(...args) { return hidden ? Promise.resolve(undefined) : vscode.window.showErrorMessage(...args); }
function isHidden() { return hidden; }
module.exports = { setHidden, isHidden, showQuickPick, showInputBox, showErrorMessage };
