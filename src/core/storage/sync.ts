import * as vscode from 'vscode';

// 只同步可跨设备使用的少量状态。账号、密钥、行情缓存和运行状态不进入白名单。
const BASE_SYNC_KEYS = ['futuresCatalogV1', 'chartIndicator', 'usDisplayMode', 'fundHoldingsCloudV1'] as const;
const HOLDINGS_KEY = 'fundHoldings';
const HOLDINGS_OPTION = 'sync.fundHoldings';
type SyncKey = (typeof BASE_SYNC_KEYS)[number] | typeof HOLDINGS_KEY;

class DataSync implements vscode.Disposable {
  private keys: readonly SyncKey[] = [];
  private snapshots = new Map<SyncKey, string | undefined>();
  private handlers: Partial<Record<SyncKey, () => void | Promise<void>>> = {};
  private listener: vscode.Disposable;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private pending?: Promise<void>;

  constructor(
    private context: vscode.ExtensionContext,
    private log = (_message: string) => {}
  ) {
    this.configure();
    this.listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`aShareTurnover.${HOLDINGS_OPTION}`)) {
        this.snapshots.delete(HOLDINGS_KEY);
        void this.reconcile();
      }
    });
  }
  private configure(): void {
    // 云端持仓副本独立于 fundHoldings；未开启开关时业务层不发布本机持仓或应用云端副本。
    // 白名单保持稳定，避免动态撤销同步键被 VS Code 当成删除云端记录而影响其他设备。
    this.keys = [...BASE_SYNC_KEYS, HOLDINGS_KEY];
    this.context.globalState.setKeysForSync([...BASE_SYNC_KEYS]);
  }
  start(handlers: Partial<Record<SyncKey, () => void | Promise<void>>>): void {
    this.handlers = handlers;
    void this.reconcile();
    // Memento 没有公开变更事件。这里只检查 VS Code 已下载到本机的状态，不发起网络请求。
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.reconcile(), 5000);
  }
  reconcile(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.applyChanges().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async applyChanges(): Promise<void> {
    for (const key of this.keys) {
      if (this.disposed) return;
      const value = JSON.stringify(this.context.globalState.get(key));
      if (this.snapshots.has(key) && this.snapshots.get(key) === value) continue;
      if (!this.handlers[key]) continue;
      try {
        await this.handlers[key]!();
        this.snapshots.set(key, value);
      } catch {
        this.log('同步数据暂未应用，下次检查时重试。');
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.listener.dispose();
  }
}

/** 由原生命令菜单按上下文筛选操作，不绕过 VS Code 的登录/同步状态。 */
async function openNativeSync(action: 'manage' | 'showData'): Promise<void> {
  const available = await vscode.commands.getCommands(true);
  if (!available.includes('workbench.userDataSync.actions.showSyncedData'))
    throw new Error('当前编辑器未提供原生设置同步，请在 VS Code 左下角账户菜单中查看。');
  if (action === 'manage') {
    // getCommands 只代表命令已注册，不代表前置条件成立。
    // 直接执行 turnOn 会在已同步时仍弹“登录”，随后服务因已启用而直接返回。
    // 原生命令面板会过滤不可用操作；英文原始别名同样支持中文等本地化界面。
    if (!available.includes('workbench.action.quickOpen'))
      throw new Error('无法打开同步操作列表，请使用 VS Code 左下角账户菜单。');
    await vscode.commands.executeCommand('workbench.action.quickOpen', '>Settings Sync: ');
  } else {
    await vscode.commands.executeCommand('workbench.userDataSync.actions.showSyncedData');
  }
}
export { DataSync, BASE_SYNC_KEYS, HOLDINGS_KEY, HOLDINGS_OPTION, openNativeSync };
