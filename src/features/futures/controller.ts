import * as vscode from 'vscode';
import * as privateUI from '../../core/ui/privacy';
import type { CommodityEntry } from '../../shared/types';
import { CommoditiesController } from '../commodities/controller';
import { entryFor, isCommodityQuote, registerCommodity } from '../commodities/data';
import { CATALOG_KEY, FuturesSearch, futuresKind, initializeFuturesCatalog } from './search';

interface FuturePick extends vscode.QuickPickItem {
  entry?: CommodityEntry;
}

// Share quote rendering/polling, but keep this view's configuration, cache and pause state independent.
class FuturesController extends CommoditiesController {
  private search: FuturesSearch;
  private activePicker?: vscode.QuickPick<FuturePick>;
  constructor(
    context,
    options: Omit<NonNullable<ConstructorParameters<typeof CommoditiesController>[1]>, 'section'> & {
      search?: FuturesSearch;
    } = {}
  ) {
    // 先恢复名称、市场和字段格式，再让父类校验自选和报价缓存，重启后仍能读取新增合约。
    initializeFuturesCatalog(context.globalState.get(CATALOG_KEY, []));
    super(context, { ...options, section: 'futures' });
    this.search = options.search || new FuturesSearch();
    this.listeners.push(
      vscode.workspace.onDidChangeConfiguration(() => {
        if (!this.enabled) this.activePicker?.hide();
      })
    );
  }
  override accepts(code: string): boolean {
    return Boolean(entryFor(code)) && !['XAU', 'XAG'].includes(code);
  }
  override async saveSelection(codes: string[]): Promise<void> {
    if (this.disposed || this.hidden || privateUI.isHidden()) return;
    const selected = this.normalizeSelection(codes);
    if (selected.length > 2000) throw new Error('期货自选最多保存2000项');
    // 元数据先于配置落盘；写入失败时不留下重启后无法识别的代码。
    await this.context.globalState.update(
      CATALOG_KEY,
      [...new Set([...selected, ...this.codes])].map((code) => entryFor(code)!)
    );
    if (!this.disposed && !this.hidden && !privateUI.isHidden()) await super.saveSelection(selected);
  }
  override async add(input?: unknown): Promise<void> {
    if (this.disposed || this.hidden || privateUI.isHidden() || !this.enabled) return;
    if (Array.isArray(input) || typeof input === 'string') {
      let codes: string[] | undefined;
      try {
        codes = this.normalizeSelection(input);
      } catch (error) {
        if (Array.isArray(input)) {
          await privateUI.showErrorMessage(error.message);
          return;
        }
      }
      if (codes) {
        await this.saveSelection([...this.codes, ...codes]);
        return;
      }
    }
    this.activePicker?.hide();
    const picker = vscode.window.createQuickPick<FuturePick>();
    this.activePicker = picker;
    picker.title = '搜索并添加期货';
    picker.placeholder = '输入名称或代码：螺纹钢 / 沪金 / LC2701 / IF / 标普 / 日经 / NQ';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.ignoreFocusOut = true;
    let timer: NodeJS.Timeout | undefined,
      searchAbort: AbortController | undefined,
      quoteAbort: AbortController | undefined;
    let generation = 0,
      closed = false,
      accepting = false;
    const unavailable = () => closed || this.disposed || this.hidden || privateUI.isHidden() || !this.enabled;
    const itemsFor = (entries: CommodityEntry[]): FuturePick[] =>
      entries
        .filter((entry) => !['XAU', 'XAG'].includes(entry.code))
        .map((entry) => ({
          label: entry.name,
          description: `${entry.code} · ${entry.market === 'domesticFutures' ? 'nf' : 'hf'}_${entry.code}${this.codes.includes(entry.code) ? ' · 已添加' : ''}`,
          detail: `${futuresKind(entry)}${entry.unit ? ' · ' + entry.unit : ''}`,
          entry,
          alwaysShow: true
        }));
    const message = (label: string, detail?: string): FuturePick => ({ label, detail, alwaysShow: true });
    const update = (value: string) => {
      if (unavailable() || accepting) return;
      const current = ++generation;
      clearTimeout(timer);
      searchAbort?.abort();
      picker.busy = false;
      picker.selectedItems = [];
      picker.activeItems = [];
      let local: CommodityEntry[];
      try {
        local = this.search.local(value, this.codes);
      } catch (error) {
        picker.items = [message(error.message)];
        return;
      }
      picker.items = itemsFor(local);
      if (!value.trim()) return;
      picker.busy = true;
      timer = setTimeout(async () => {
        if (unavailable()) return;
        const abort = (searchAbort = new AbortController());
        try {
          const remote = await this.search.search(value, abort.signal);
          if (unavailable() || abort.signal.aborted || current !== generation) return;
          const merged = new Map([...local, ...remote].map((entry) => [entry.code, entry]));
          picker.items = itemsFor([...merged.values()]);
          if (!picker.items.length)
            picker.items = [
              message('未找到该期货，请换名称或完整合约代码', '支持新浪收录的国内主连、月份合约及海外期货参考行情')
            ];
        } catch (error) {
          if (unavailable() || abort.signal.aborted || current !== generation) return;
          picker.items = [
            ...itemsFor(local),
            message('在线搜索暂不可用，当前仅列出本地候选', '修改关键词可重试：' + error.message)
          ];
        } finally {
          if (!unavailable() && current === generation) picker.busy = false;
        }
      }, 300);
    };
    await new Promise<void>((resolve) => {
      const listeners = [
        picker.onDidChangeValue(update),
        picker.onDidAccept(async () => {
          const entry = picker.selectedItems[0]?.entry || picker.activeItems[0]?.entry;
          if (!entry || accepting || unavailable()) return;
          if (this.codes.includes(entry.code)) {
            picker.hide();
            return;
          }
          accepting = true;
          generation++;
          clearTimeout(timer);
          searchAbort?.abort();
          picker.enabled = false;
          picker.busy = true;
          picker.title = `正在验证 ${entry.name} 的行情…`;
          const abort = (quoteAbort = new AbortController());
          try {
            registerCommodity(entry);
            const result = await this.provider.load([entry.code], abort.signal);
            if (unavailable() || abort.signal.aborted) return;
            const quote = result.quotes.get(entry.code);
            if (
              result.errors.has(entry.code) ||
              !isCommodityQuote(quote) ||
              quote.price === 0 ||
              quote.timestamp * 1000 > this.now().getTime() + 300000
            )
              throw new Error(result.errors.get(entry.code) || '暂无有效报价，可能尚未上市或已经到期');
            await this.saveSelection([...this.codes, entry.code]);
            if (unavailable()) return;
            // 添加完成立即展示验证到的报价，不必再等下一轮刷新。
            if (quote.timestamp >= (this.quotes.get(entry.code)?.timestamp || 0)) this.quotes.set(entry.code, quote);
            this.publish(true);
            picker.hide();
          } catch (error) {
            if (!unavailable()) {
              picker.title = '暂未添加，请重试或选择其他合约';
              picker.items = [message(`无法获取 ${entry.name} 的有效行情`, error.message), ...itemsFor([entry])];
            }
          } finally {
            accepting = false;
            if (!unavailable()) {
              picker.enabled = true;
              picker.busy = false;
            }
          }
        }),
        picker.onDidHide(() => {
          closed = true;
          clearTimeout(timer);
          searchAbort?.abort();
          quoteAbort?.abort();
          for (const listener of listeners) listener.dispose();
          picker.dispose();
          if (this.activePicker === picker) this.activePicker = undefined;
          resolve();
        })
      ];
      const initial = typeof input === 'string' ? input : '';
      picker.value = initial;
      picker.show();
      update(initial);
    });
  }
  override setHidden(hidden: boolean): void {
    if (hidden) this.activePicker?.hide();
    super.setHidden(hidden);
  }
  override dispose(): void {
    this.activePicker?.hide();
    super.dispose();
  }
}
export { FuturesController };
