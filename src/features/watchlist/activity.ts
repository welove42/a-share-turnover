import * as vscode from 'vscode';
import type { WatchlistController } from './controller';

const KEY = 'stockActivityV1';
interface StockActivityEntry {
  symbol: string;
  market: 'a' | 'hk' | 'us';
  date: string;
  timestamp: string;
  label: string;
  unread: boolean;
  observedAt: number;
}

/** 仅展示A股异动；港美股仍可弹窗，但不产生高亮、角标或自动定位。 */
export class StockActivity implements vscode.Disposable {
  private entries = new Map<string, StockActivityEntry>();
  private listeners: vscode.Disposable[];
  private write = Promise.resolve();
  private revision = 0;
  private disposed = false;
  constructor(private owner: WatchlistController) {
    const saved = owner.context.globalState.get(KEY, []);
    if (Array.isArray(saved))
      for (const item of saved.slice(0, 500)) {
        if (
          item &&
          typeof item.symbol === 'string' &&
          ['a', 'hk', 'us'].includes(item.market) &&
          /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
          /^\d{14}$/.test(item.timestamp) &&
          typeof item.label === 'string' &&
          item.label.length <= 120 &&
          typeof item.unread === 'boolean' &&
          Number.isFinite(item.observedAt)
        )
          this.entries.set(item.symbol, item);
      }
    this.listeners = [
      owner.tree.onDidChangeVisibility((event) => {
        this.revision++;
        if (event.visible) void this.revealLatest();
      }),
      owner.tree.onDidChangeSelection((event) => {
        if (!this.visible()) return;
        for (const item of event.selection) if (item?.symbol) this.read(item.symbol);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('aShareTurnover.stockAlerts')) {
          this.refresh();
          owner.emitter.fire(undefined);
        }
      })
    ];
    this.refresh();
  }
  private visible() {
    const hidden = this.owner.hidden ?? this.owner.context.globalState.get('bossKeyHidden', false);
    return (
      !this.disposed &&
      !hidden &&
      this.owner.config.enabled &&
      vscode.workspace.getConfiguration('aShareTurnover').get<string>('stockAlerts.mode', 'whenVisible') !== 'never'
    );
  }
  private save() {
    const saved = [...this.entries.values()];
    this.write = this.write
      .catch(() => {})
      .then(() => this.owner.context.globalState.update(KEY, saved))
      .catch(() => {});
  }
  refresh() {
    if (this.disposed) return;
    let changed = false;
    for (const [symbol, item] of this.entries) {
      // 同时清理旧版保存的港美股标记，避免重启后恢复已经停用的高亮。
      if (item.market !== 'a' || !this.owner.config.symbols.includes(symbol) || item.date !== this.owner.clock().date) {
        this.entries.delete(symbol);
        changed = true;
      }
    }
    if (changed) this.save();
    const count = this.visible() ? [...this.entries.values()].filter((e) => e.unread).length : 0;
    if ((this.owner.tree.badge?.value || 0) !== count)
      this.owner.tree.badge = count
        ? { value: count, tooltip: `${count} 只A股自选有未读异动；打开后定位最近一只` }
        : undefined;
  }
  record(q: { symbol: string; date: string; timestamp: string }, market: 'a' | 'hk' | 'us', label: string) {
    if (this.disposed || market !== 'a') return;
    this.entries.set(q.symbol, {
      symbol: q.symbol,
      date: q.date,
      timestamp: q.timestamp,
      market,
      label: label.slice(0, 120),
      unread: true,
      observedAt: this.owner.now().getTime()
    });
    this.save();
    this.refresh();
    if (this.visible()) this.owner.emitter.fire(undefined);
  }
  private read(symbol: string, expected?: StockActivityEntry) {
    const item = this.entries.get(symbol);
    if (!item?.unread || (expected && item !== expected)) return;
    // 保留行内原因和高亮，已读仅减少角标；点击后标记不会立刻消失。
    this.entries.set(symbol, { ...item, unread: false });
    this.save();
    this.refresh();
    this.owner.emitter.fire(undefined);
  }
  clear(element?: { symbol?: string } | string) {
    if (this.disposed || !this.visible()) return;
    const target = element ?? this.owner.tree.selection[0];
    const symbol = typeof target === 'string' ? target : target?.symbol;
    if (!symbol || !this.entries.delete(symbol)) return;
    this.revision++;
    this.save();
    this.refresh();
    this.owner.emitter.fire(undefined);
  }
  clearAll() {
    if (this.disposed || !this.visible() || !this.entries.size) return;
    this.revision++;
    this.entries.clear();
    this.save();
    this.refresh();
    this.owner.emitter.fire(undefined);
  }
  async revealLatest() {
    this.refresh();
    if (!this.visible()) return;
    const latest = [...this.entries.values()].filter((e) => e.unread).sort((a, b) => b.observedAt - a.observedAt)[0];
    if (!latest) return;
    const revision = this.revision;
    const element = this.owner.element(latest.symbol);
    try {
      // reveal 自动展开祖先分组；不打开图表，也不主动从编辑器抢焦点。
      await this.owner.tree.reveal(element, { select: true, focus: false, expand: true });
      if (revision === this.revision && this.visible() && this.owner.tree.visible) this.read(latest.symbol, latest);
    } catch {
      /* 分组刷新或用户切走时保留未读，下次打开再定位。 */
    }
  }
  decorate(item: vscode.TreeItem, element: any): vscode.TreeItem {
    if (!this.visible()) return item;
    const entry = element.symbol && this.entries.get(element.symbol);
    if (entry) {
      const time = `${entry.timestamp.slice(8, 10)}:${entry.timestamp.slice(10, 12)}`;
      const label = typeof item.label === 'string' ? item.label : item.label?.label || element.symbol;
      item.label = { label, highlights: [[0, label.length]] };
      item.description = `${entry.unread ? '● ' : ''}${time} ${entry.label}${item.description ? ' · ' + item.description : ''}`;
      const note = `\n最近异动：${entry.date} ${time} ${entry.label}（北京行情时间）。${entry.unread ? '未读' : '已查看'}，这是触发记录，不代表仍处于该状态。`;
      if (item.tooltip instanceof vscode.MarkdownString) item.tooltip.appendText(note);
      else item.tooltip = String(item.tooltip || '') + note;
      item.accessibilityInformation = { label: `${item.accessibilityInformation?.label || label}，${note.trim()}` };
    } else if (['group', 'overseasGroup', 'stockGroup'].includes(element.kind)) {
      const market = element.market || 'a';
      const count = [...this.entries.values()].filter(
        (e) =>
          e.unread &&
          e.market === market &&
          (element.kind !== 'stockGroup' || this.owner.groupingFor(market).idFor(e.symbol) === element.id)
      ).length;
      if (count) item.description = `${count} 只未读异动 · ${item.description || ''}`;
    }
    return item;
  }
  dispose() {
    this.disposed = true;
    this.revision++;
    this.owner.tree.badge = undefined;
    for (const listener of this.listeners) listener.dispose();
  }
}
