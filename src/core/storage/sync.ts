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
    // 云端持仓副本独立于 fundHoldings；用户明确关闭同步时不发布本机持仓或应用云端副本。
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

export { DataSync, BASE_SYNC_KEYS, HOLDINGS_KEY, HOLDINGS_OPTION };
