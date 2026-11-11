import {
  CATEGORIES,
  DIRECTIONS,
  compare,
  cacheKey,
  CONCEPT_POLL_MS,
  SINA_URLS,
  parseSinaAll,
  selectSina,
  parseSina,
  parseSinaConcept,
  restoreSina,
  parseSectors,
  SectorProvider
} from './data';
import * as vscode from 'vscode';
import * as privateUI from '../../core/ui/privacy';
import { SectorBoard } from './board';
import { stockSession, shanghaiClock, POLL_MS } from '../turnover/market';
interface SectorPick extends vscode.QuickPickItem {
  action?: string;
  direction?: string;
  category?: string;
}
class SectorsController {
  declare context: any;
  declare provider: SectorProvider;
  declare now: () => Date;
  declare disposed: boolean;
  declare inflight: any;
  declare abort: AbortController | null;
  declare lastAttempt: number;
  declare generation: number;
  declare error: string;
  declare retryCount: number;
  declare rendered: { text?: string; tooltip?: string };
  declare visible: boolean;
  declare item: vscode.StatusBarItem;
  declare listener: vscode.Disposable;
  declare rows: any;
  declare enabled: boolean | undefined;
  declare category: string;
  declare direction: string;
  declare closedDates: any[] | undefined;
  declare timer: NodeJS.Timeout | undefined;
  declare hidden: any;
  declare board: SectorBoard;

  constructor(context, { provider = new SectorProvider(), now = () => new Date() } = {}) {
    this.context = context;
    this.provider = provider;
    this.now = now;
    this.disposed = false;
    this.inflight = null;
    this.abort = null;
    this.lastAttempt = -Infinity;
    this.generation = 0;
    this.error = '';
    this.retryCount = 0;
    this.rendered = {};
    this.visible = false;
    this.item = vscode.window.createStatusBarItem('aShareTurnover.sectors', vscode.StatusBarAlignment.Right, 98);
    this.item.name = 'A股板块排行';
    this.readConfig();
    this.restore();
    this.board = new SectorBoard(this);
    this.item.command = 'welove42.aShareTurnover.sectors.open';
    this.listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration('aShareTurnover.sectors') &&
        !event.affectsConfiguration('aShareTurnover.additionalClosedDates')
      )
        return;
      const old = this.category,
        oldDirection = this.direction,
        enabled = this.enabled;
      this.readConfig();
      const changed = old !== this.category || oldDirection !== this.direction;
      if (changed || !this.enabled) {
        this.generation++;
        this.abort?.abort();
      }
      if (changed) {
        this.rows = null;
        this.error = '';
        this.retryCount = 0;
        if (old !== this.category) this.provider.resetCooldowns?.();
        this.restore();
      }
      this.render();
      this.board.update();
      if (this.enabled && (!enabled || changed)) void (this.inflight || Promise.resolve()).then(() => this.refresh());
    });
  }
  readConfig() {
    const c = vscode.workspace.getConfiguration('aShareTurnover');
    this.enabled = c.get('sectors.enabled', true);
    this.category = Object.hasOwn(CATEGORIES, c.get('sectors.category', 'industry'))
      ? c.get('sectors.category', 'industry')
      : 'industry';
    this.direction = Object.hasOwn(DIRECTIONS, c.get('sectors.direction', 'gainers'))
      ? c.get('sectors.direction', 'gainers')
      : 'gainers';
    this.closedDates = c.get('additionalClosedDates', []);
  }
  restore() {
    const cached =
      this.context.globalState.get('sectorRankings', {})[cacheKey(this.category, this.direction)] ||
      (this.direction === 'gainers' ? this.context.globalState.get('sectorRanking', null) : null);
    if (
      cached?.category !== this.category ||
      (cached.direction || 'gainers') !== this.direction ||
      !Array.isArray(cached.rows)
    )
      return;
    try {
      this.rows =
        cached.rows[0]?.source === 'sina'
          ? restoreSina(cached.rows, this.category, this.now().getTime(), this.direction)
          : parseSectors(
              {
                rc: 0,
                data: { diff: cached.rows.map((r) => ({ f12: r.code, f14: r.name, f3: r.percent, f124: r.timestamp })) }
              },
              this.category,
              this.now().getTime(),
              this.direction
            );
    } catch {
      /* ignore invalid cache */
    }
  }
  start() {
    this.render();
    this.timer = setInterval(() => this.tick(), 1000);
    if (this.enabled) void this.refresh();
  }
  tick() {
    if (this.disposed || this.hidden || !this.enabled) return;
    this.render();
    const trading = stockSession(this.now(), this.closedDates).polling;
    const due = trading
      ? this.now().getTime() - this.lastAttempt >= (this.category === 'concept' ? CONCEPT_POLL_MS : POLL_MS)
      : this.error && this.retryCount < 5 && this.now().getTime() - this.lastAttempt >= 60000;
    if (!this.inflight && due) void this.refresh();
  }
  retry() {
    if (this.disposed || this.hidden || !this.enabled) return Promise.resolve();
    this.retryCount = 0;
    this.provider.resetCooldowns?.();
    return (this.inflight || Promise.resolve()).then(() => this.refresh());
  }
  async showMenu() {
    if (this.disposed || this.hidden || !this.enabled) return;
    const selected = await privateUI.showQuickPick<SectorPick>(
      [
        ...Object.entries(CATEGORIES).map(([category, entry]) => ({
          label: `${entry.name}板块`,
          description: category === this.category ? '当前显示' : '',
          category
        })),
        ...Object.entries(DIRECTIONS).map(([direction, entry]) => ({
          label: `$(${entry.icon}) ${entry.name}`,
          description: direction === this.direction ? '当前显示' : '',
          direction
        })),
        { label: '$(refresh) 立即刷新', action: 'refresh' }
      ],
      {
        title: `${CATEGORIES[this.category].name}板块 · ${DIRECTIONS[this.direction].name}`,
        placeHolder: '切换行业 / 概念、涨幅 / 跌幅榜，也可以手动刷新'
      }
    );
    if (!selected || this.disposed || this.hidden || !this.enabled) return;
    if (selected.action === 'refresh') return this.retry();
    const key = Object.hasOwn(DIRECTIONS, selected.direction || '')
      ? 'sectors.direction'
      : Object.hasOwn(CATEGORIES, selected.category || '')
        ? 'sectors.category'
        : null;
    const value = key === 'sectors.direction' ? selected.direction : selected.category;
    if (!key || value === (key === 'sectors.direction' ? this.direction : this.category)) return;
    try {
      const config = vscode.workspace.getConfiguration('aShareTurnover');
      const inspected = config.inspect?.(key);
      const target =
        inspected?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      await config.update(key, value, target);
    } catch (error) {
      await privateUI.showErrorMessage(`切换板块失败：${error.message}`);
    }
  }
  refresh() {
    if (this.disposed || this.hidden || !this.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const abort = (this.abort = new AbortController()),
      generation = this.generation,
      category = this.category,
      direction = this.direction;
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      try {
        const rows = await this.provider.load(category, abort.signal, this.now().getTime(), direction);
        if (abort.signal.aborted || this.disposed || generation !== this.generation) return;
        const newest = Math.max(...rows.map((r) => r.timestamp));
        if (
          this.rows &&
          (this.rows[0].source || 'eastmoney') === (rows[0].source || 'eastmoney') &&
          newest < Math.max(...this.rows.map((r) => r.timestamp))
        )
          throw new Error('行情时间早于上次结果');
        this.rows = rows;
        this.error = '';
        this.retryCount = 0;
        const saved = this.context.globalState.get('sectorRankings', {});
        await this.context.globalState
          .update('sectorRankings', { ...saved, [cacheKey(category, direction)]: { category, direction, rows } })
          .catch(() => {});
      } catch (error) {
        if (!abort.signal.aborted && !this.disposed && generation === this.generation) {
          this.error = error.message || '获取失败';
          this.retryCount++;
        }
      } finally {
        this.inflight = null;
        this.abort = null;
        if (!this.disposed) this.render();
      }
    })();
    return this.inflight;
  }
  render() {
    if (!this.enabled || this.hidden) {
      if (this.visible) {
        this.item.hide();
        this.visible = false;
      }
      return;
    }
    const clock = stockSession(this.now(), this.closedDates),
      rows = this.rows,
      first = rows?.[0];
    const oldest = rows && Math.min(...rows.map((r) => r.timestamp)),
      stamp = oldest ? shanghaiClock(new Date(oldest * 1000)) : null;
    const sina = first?.source === 'sina';
    const stale = Boolean(
      this.error ||
        !stamp ||
        stamp.date !== clock.date ||
        (clock.polling && this.now().getTime() - oldest * 1000 > 120000)
    );
    const format = (p) => `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
    const label = DIRECTIONS[this.direction].label;
    const text = first
      ? `${label} ${first.name} ${format(first.percent)}${sina ? ' · 参考' : ''}`
      : `${label} ${this.error ? '获取失败' : '待获取'}`;
    const tip = new vscode.MarkdownString();
    tip.isTrusted = false;
    tip.appendText(
      `${sina ? `新浪${CATEGORIES[this.category].name}板块（备用，分类口径与东方财富不同）` : `东方财富${CATEGORIES[this.category].name}板块`} · ${DIRECTIONS[this.direction].name}\n${sina && stamp ? `获取时间：${stamp.date} ${stamp.time}（北京）；页面未提供行情时间，不保证实时` : stamp ? `行情时间：${stamp.date} ${stamp.time}（北京，最早报价）` : '尚无可用行情'}${stale && first ? '\n当前为历史或未更新行情' : ''}${this.error ? `\n获取失败：${this.error}` : ''}\n\n`
    );
    if (rows) rows.forEach((r, i) => tip.appendText(`${i + 1}. ${r.name} ${format(r.percent)}\n`));
    if (rows && (this.direction === 'losers' ? rows.some((r) => r.percent >= 0) : rows.some((r) => r.percent <= 0)))
      tip.appendText(
        `\n按涨跌幅从${this.direction === 'losers' ? '低到高' : '高到低'}排列，${this.direction === 'losers' ? '下跌' : '上涨'}板块不足十个时包含其余板块。\n`
      );
    tip.appendText(
      `\n交易期间每${this.category === 'concept' ? 60 : 10}秒更新；新浪备用榜最多每60秒获取一次。点击打开板块行情与热点云图。`
    );
    if (text !== this.rendered.text) this.item.text = text;
    if (tip.value !== this.rendered.tooltip) this.item.tooltip = tip;
    this.rendered = { text, tooltip: tip.value };
    if (!this.visible) {
      this.item.show();
      this.visible = true;
    }
  }
  setHidden(hidden) {
    this.hidden = hidden;
    this.board.setHidden(hidden);
    if (hidden) {
      this.generation++;
      this.abort?.abort();
    }
    this.render();
    if (!hidden && this.enabled)
      void (this.inflight || Promise.resolve()).then(() => {
        if (!this.disposed && !this.hidden && this.enabled) return this.refresh();
      });
  }
  dispose() {
    this.disposed = true;
    this.board.dispose();
    this.generation++;
    clearInterval(this.timer);
    this.abort?.abort();
    this.listener.dispose();
    this.item.dispose();
  }
}
export { SectorProvider, SectorsController, parseSectors, parseSinaConcept };
