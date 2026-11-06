import type { StockGroup } from '../../shared/types';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as privateUI from '../../core/ui/privacy';
import { normalizeSymbol, orderedSymbols } from './quotes';
const UNGROUPED = 'ungrouped';
const MAX_GROUPS = 30;
function groupName(value: unknown, groups: StockGroup[] = [], exceptId?: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 30 || /[\x00-\x1f\x7f]/.test(name))
    throw new Error('分组名称需为 1–30 个字符，不能包含换行。');
  if (name === '未分组' || groups.some((g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase()))
    throw new Error('分组名称已存在，请换一个名称。');
  return name;
}
function normalizeGroups(value: unknown, symbols: string[], normalize = normalizeSymbol): StockGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: StockGroup[] = [],
    ids = new Set<string>(),
    assigned = new Set<string>();
  for (const raw of value.slice(0, MAX_GROUPS)) {
    if (
      !raw ||
      typeof raw.id !== 'string' ||
      !/^[a-zA-Z0-9][\w-]{0,63}$/.test(raw.id) ||
      raw.id === UNGROUPED ||
      ids.has(raw.id)
    )
      continue;
    let name;
    try {
      name = groupName(raw.name, groups);
    } catch {
      continue;
    }
    const members = new Set();
    if (Array.isArray(raw.symbols))
      for (const value of raw.symbols) {
        try {
          members.add(normalize(value));
        } catch {
          /* Invalid entries stay outside the group. */
        }
      }
    const selected = symbols.filter((s) => members.has(s) && !assigned.has(s));
    selected.forEach((s) => assigned.add(s));
    ids.add(raw.id);
    groups.push({ id: raw.id, name, symbols: selected });
  }
  return groups;
}
class StockGroups {
  declare parent: any;
  declare market: string;
  declare elements: Map<any, any>;
  declare label: string | undefined;
  declare groupsKey: string;
  declare symbolsKey: string;

  constructor(parent, market = 'a') {
    this.parent = parent;
    this.market = market;
    this.elements = new Map();
    this.label = { a: 'A 股', hk: '港股', us: '美股' }[market];
    this.groupsKey = market === 'a' ? 'stocks.groups' : `stocks.${market}Groups`;
    this.symbolsKey = market === 'a' ? 'stocks.symbols' : `stocks.${market}Symbols`;
  }
  get config(): { symbols: string[]; groups: StockGroup[]; sortBy: string } {
    return this.market === 'a'
      ? this.parent.config
      : {
          ...this.parent.config,
          symbols: this.parent.overseas.symbols[this.market],
          groups: this.parent.overseas.stockGroups[this.market]
        };
  }
  get quotes() {
    return this.market === 'a' ? this.parent.quotes : this.parent.overseas.displayQuotes(this.market);
  }
  get groups() {
    return this.config.groups;
  }
  allowed() {
    return !this.parent.disposed && !this.parent.hidden;
  }
  bucket(id) {
    return this.buckets().find((g) => g.id === id);
  }
  buckets() {
    const assigned = new Set(this.groups.flatMap((g) => g.symbols));
    return [
      ...this.groups.map((g) => ({ ...g, custom: true })),
      { id: UNGROUPED, name: '未分组', custom: false, symbols: this.config.symbols.filter((s) => !assigned.has(s)) }
    ];
  }
  idFor(symbol) {
    return this.groups.find((g) => g.symbols.includes(symbol))?.id || UNGROUPED;
  }
  element(id) {
    if (!this.elements.has(id)) this.elements.set(id, { kind: 'stockGroup', market: this.market, id });
    return this.elements.get(id);
  }
  children(id) {
    const g = this.bucket(id),
      source = this.market === 'a' ? this.parent : this.parent.overseas;
    return g ? orderedSymbols(g.symbols, this.quotes, this.config.sortBy).map((s) => source.element(s)) : [];
  }
  add(id = UNGROUPED) {
    return this.market === 'a'
      ? this.parent.searchAndAdd('', 'a', id)
      : this.parent.overseas.add({ market: this.market }, id);
  }
  treeItem(element) {
    const g = this.bucket(element.id);
    const item = new vscode.TreeItem(
      g ? `${g.name} (${g.symbols.length})` : '',
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = `${this.market === 'a' ? 'a-share' : this.market}-group:${element.id}`;
    item.contextValue = g?.custom ? 'aShareCustomGroup' : 'aShareUngrouped';
    item.iconPath = new vscode.ThemeIcon('folder');
    item.tooltip = g?.custom
      ? '拖入个股可移动到此分组；拖动分组可排序。删除分组会保留个股并移到未分组。'
      : `尚未归类的${this.label}自选；可拖入或拖出个股。`;
    return item;
  }
  async pickGroup(element) {
    const id = typeof element === 'string' ? element : element?.id;
    if (id) return this.groups.find((g) => g.id === id);
    const selected = await privateUI.showQuickPick(
      this.groups.map((g) => ({ label: g.name, description: `${g.symbols.length} 只`, id: g.id })),
      { title: `选择${this.label}分组` }
    );
    return this.groups.find((g) => g.id === selected?.id);
  }
  async create(value?: string) {
    if (!this.allowed()) return;
    if (this.groups.length >= MAX_GROUPS) throw new Error(`最多创建 ${MAX_GROUPS} 个分组。`);
    const input =
      typeof value === 'string'
        ? value
        : await privateUI.showInputBox({
            title: `新建${this.label}分组`,
            placeHolder: '例如：持仓、观察、ETF',
            validateInput: (text) => {
              try {
                groupName(text, this.groups);
              } catch (e) {
                return e.message;
              }
            }
          });
    if (input === undefined || !this.allowed()) return;
    return this.parent.enqueueSettings(async () => {
      if (!this.allowed()) return;
      if (this.groups.length >= MAX_GROUPS) throw new Error(`最多创建 ${MAX_GROUPS} 个分组。`);
      const name = groupName(input, this.groups),
        id = 'g-' + randomUUID();
      await this.parent.writeSettings([[this.groupsKey, [...this.groups, { id, name, symbols: [] }]]], false);
      return id;
    });
  }
  async rename(element, value?: string) {
    if (!this.allowed()) return;
    const group = await this.pickGroup(element);
    if (!group) return;
    const input =
      typeof value === 'string'
        ? value
        : await privateUI.showInputBox({
            title: `重命名${this.label}分组`,
            value: group.name,
            validateInput: (text) => {
              try {
                groupName(text, this.groups, group.id);
              } catch (e) {
                return e.message;
              }
            }
          });
    if (input === undefined || !this.allowed()) return;
    return this.parent.enqueueSettings(async () => {
      if (!this.allowed() || !this.groups.some((g) => g.id === group.id)) return;
      const name = groupName(input, this.groups, group.id);
      await this.parent.writeSettings(
        [[this.groupsKey, this.groups.map((g) => (g.id === group.id ? { ...g, name } : g))]],
        false
      );
    });
  }
  async remove(element) {
    if (!this.allowed()) return;
    const group = await this.pickGroup(element);
    if (!group) return;
    return this.parent.enqueueSettings(async () => {
      if (this.allowed())
        await this.parent.writeSettings([[this.groupsKey, this.groups.filter((g) => g.id !== group.id)]], false);
    });
  }
  async move(element, targetId?: string) {
    if (!this.allowed()) return;
    let symbol = typeof element === 'string' ? element : element?.symbol;
    if (!symbol)
      symbol = (
        await privateUI.showQuickPick(
          this.config.symbols.map((s) => ({ label: this.quotes.get(s)?.name || s, description: s, symbol: s })),
          { title: `选择要移动的${this.label}` }
        )
      )?.symbol;
    if (!this.config.symbols.includes(symbol)) return;
    if (targetId === undefined) {
      const picked = await privateUI.showQuickPick(
        [
          ...this.buckets().map((g) => ({
            label: g.name,
            description: g.id === this.idFor(symbol) ? '当前分组' : `${g.symbols.length} 只`,
            id: g.id
          })),
          { label: '＋ 新建分组…', create: true }
        ],
        { title: `移动到${this.label}分组` }
      );
      if (!picked) return;
      targetId = 'create' in picked ? await this.create() : picked.id;
    }
    if (!targetId || !this.allowed() || targetId === this.idFor(symbol)) return;
    return this.parent.enqueueSettings(() => this.moveNow([symbol], targetId));
  }
  async moveNow(symbols: string[], targetId: string, targetSymbol?: string) {
    if (!this.allowed()) return;
    const p = this.parent,
      destination = this.bucket(targetId),
      moving = new Set(symbols);
    if (!destination || !moving.size || symbols.some((s) => !this.config.symbols.includes(s)))
      throw new Error('分组或个股已不存在，请重试。');
    if (targetSymbol && (!destination.symbols.includes(targetSymbol) || moving.has(targetSymbol))) return;
    const buckets = this.buckets().map((g) => ({
      ...g,
      symbols: orderedSymbols(g.symbols, this.quotes, this.config.sortBy)
    }));
    const selected = buckets.flatMap((g) => g.symbols).filter((s) => moving.has(s));
    const original = buckets.find((g) => g.id === targetId)!.symbols;
    const rest = original.filter((s) => !moving.has(s));
    let at = rest.length;
    if (targetSymbol) {
      at = rest.indexOf(targetSymbol);
      if (selected.every((s) => original.includes(s)) && original.indexOf(selected[0]) < original.indexOf(targetSymbol))
        at++;
    }
    const next = buckets.map((g) => ({
      ...g,
      symbols:
        g.id === targetId
          ? [...rest.slice(0, at), ...selected, ...rest.slice(at)]
          : g.symbols.filter((s) => !moving.has(s))
    }));
    const ordered = next.flatMap((g) => g.symbols);
    const groups = next.filter((g) => g.custom).map(({ id, name, symbols }) => ({ id, name, symbols }));
    if (
      JSON.stringify(groups) === JSON.stringify(this.groups) &&
      JSON.stringify(ordered) === JSON.stringify(this.config.symbols) &&
      this.config.sortBy === 'manual'
    )
      return;
    await p.writeSettings(
      [
        [this.symbolsKey, ordered],
        [this.groupsKey, groups],
        ['stocks.sortBy', 'manual']
      ],
      false
    );
  }
  reorder(ids: string[], targetId?: string, token?: vscode.CancellationToken) {
    return this.parent.enqueueSettings(async () => {
      if (!this.allowed() || token?.isCancellationRequested || (token && !this.parent.config.enabled)) return;
      const selected = new Set(ids),
        order = this.groups.map((g) => g.id);
      if (!ids.length || ids.some((id) => !order.includes(id)) || selected.has(targetId || '')) return;
      if (targetId !== undefined && targetId !== UNGROUPED && !order.includes(targetId)) return;
      const rest = this.groups.filter((g) => !selected.has(g.id)),
        moving = this.groups.filter((g) => selected.has(g.id));
      let at = rest.length;
      if (targetId && targetId !== UNGROUPED) {
        at = rest.findIndex((g) => g.id === targetId);
        if (order.indexOf(moving[0].id) < order.indexOf(targetId)) at++;
      }
      const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
      if (JSON.stringify(next) !== JSON.stringify(this.groups))
        await this.parent.writeSettings([[this.groupsKey, next]], false);
    });
  }
  shift(id, direction) {
    const index = this.groups.findIndex((g) => g.id === id),
      target = this.groups[index + direction];
    if (index >= 0 && target && [1, -1].includes(direction)) return this.reorder([id], target.id);
  }
}
export { StockGroups, normalizeGroups, groupName, UNGROUPED, MAX_GROUPS };
