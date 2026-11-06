import * as vscode from 'vscode';
let hidden = false;
const pending = new Set<vscode.CancellationTokenSource>();
function setHidden(value: boolean) {
  hidden = Boolean(value);
  if (hidden) for (const token of pending) token.cancel();
}
/** 老板键激活时取消尚未结束的输入操作，避免隐藏后再弹出行情界面。 */
async function request<T>(open: (token: vscode.CancellationToken) => Thenable<T>): Promise<T | undefined> {
  if (hidden) return undefined;
  const source = new vscode.CancellationTokenSource();
  pending.add(source);
  try {
    const result = await open(source.token);
    return hidden || source.token.isCancellationRequested ? undefined : result;
  } finally {
    pending.delete(source);
    source.dispose();
  }
}
function showQuickPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: vscode.QuickPickOptions & { canPickMany: true }
): Promise<T[] | undefined>;
function showQuickPick<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options?: vscode.QuickPickOptions
): Promise<T | undefined>;
function showQuickPick(items: readonly string[], options?: vscode.QuickPickOptions): Promise<string | undefined>;
function showQuickPick(
  items: readonly (string | vscode.QuickPickItem)[],
  options?: vscode.QuickPickOptions
): Promise<string | vscode.QuickPickItem | vscode.QuickPickItem[] | undefined> {
  return request((token) => vscode.window.showQuickPick(items as vscode.QuickPickItem[], options, token));
}
function showInputBox(options?: vscode.InputBoxOptions): Promise<string | undefined> {
  return request((token) => vscode.window.showInputBox(options, token));
}
function showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined> {
  return hidden ? Promise.resolve(undefined) : vscode.window.showErrorMessage(message, ...items);
}
function isHidden() {
  return hidden;
}
export { setHidden, isHidden, showQuickPick, showInputBox, showErrorMessage };
