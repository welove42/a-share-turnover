'use strict';
const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const privateUI = require('./privacy-ui');
const { normalizeSymbol, orderedSymbols } = require('./quotes');
const UNGROUPED = 'ungrouped';
const MAX_GROUPS = 30;
function groupName(value, groups = [], exceptId) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 30 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('分组名称需为 1–30 个字符，不能包含换行。');
  if (name === '未分组' || groups.some(g => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase())) throw new Error('分组名称已存在，请换一个名称。');
  return name;
}
function normalizeGroups(value, symbols) {
  if (!Array.isArray(value)) return [];
  const groups = [], ids = new Set(), assigned = new Set();
  for (const raw of value.slice(0, MAX_GROUPS)) {
    if (!raw || typeof raw.id !== 'string' || !/^[a-zA-Z0-9][\w-]{0,63}$/.test(raw.id) || raw.id === UNGROUPED || ids.has(raw.id)) continue;
    let name;
    try { name = groupName(raw.name, groups); } catch { continue; }
    const members = new Set();
    if (Array.isArray(raw.symbols)) for (const value of raw.symbols) { try { members.add(normalizeSymbol(value)); } catch { /* Invalid entries stay outside the group. */ } }
    const selected = symbols.filter(s => members.has(s) && !assigned.has(s));
    selected.forEach(s => assigned.add(s)); ids.add(raw.id);
    groups.push({ id: raw.id, name, symbols: selected });
  }
  return groups;
}
class StockGroups {
  constructor(parent) { this.parent = parent; this.elements = new Map(); }
  get groups() { return this.parent.config.groups; }
  allowed() { return !this.parent.disposed && !this.parent.hidden; }
  bucket(id) { return this.buckets().find(g => g.id === id); }
  buckets() {
    const assigned = new Set(this.groups.flatMap(g => g.symbols));
    return [...this.groups.map(g => ({ ...g, custom: true })), { id: UNGROUPED, name: '未分组', custom: false, symbols: this.parent.config.symbols.filter(s => !assigned.has(s)) }];
  }
  idFor(symbol) { return this.groups.find(g => g.symbols.includes(symbol))?.id || UNGROUPED; }
  element(id) {
    if (!this.elements.has(id)) this.elements.set(id, { kind: 'stockGroup', id });
    return this.elements.get(id);
  }
  children(id) { const g = this.bucket(id); return g ? orderedSymbols(g.symbols, this.parent.quotes, this.parent.config.sortBy).map(s => this.parent.element(s)) : []; }
  treeItem(element) {
    const g = this.bucket(element.id);
    const item = new vscode.TreeItem(g ? `${g.name} (${g.symbols.length})` : '', vscode.TreeItemCollapsibleState.Expanded);
    item.id = `a-share-group:${element.id}`; item.contextValue = g?.custom ? 'aShareCustomGroup' : 'aShareUngrouped';
    item.iconPath = new vscode.ThemeIcon('folder');
    item.tooltip = g?.custom ? '拖入个股可移动到此分组；拖动分组可排序。删除分组会保留个股并移到未分组。' : '尚未归类的 A 股自选；可拖入或拖出个股。';
    return item;
  }
  async pickGroup(element) {
    const id = typeof element === 'string' ? element : element?.id;
    if (id) return this.groups.find(g => g.id === id);
    const selected = await privateUI.showQuickPick(this.groups.map(g => ({ label: g.name, description: `${g.symbols.length} 只`, id: g.id })), { title: '选择 A 股分组' });
    return this.groups.find(g => g.id === selected?.id);
  }
  async create(value) {
    if (!this.allowed()) return;
    if (this.groups.length >= MAX_GROUPS) throw new Error(`最多创建 ${MAX_GROUPS} 个分组。`);
    const input = typeof value === 'string' ? value : await privateUI.showInputBox({ title: '新建 A 股分组', placeHolder: '例如：持仓、观察、ETF', validateInput: text => { try { groupName(text, this.groups); } catch (e) { return e.message; } } });
    if (input === undefined || !this.allowed()) return;
    return this.parent.enqueueSettings(async () => {
      if (!this.allowed()) return;
      if (this.groups.length >= MAX_GROUPS) throw new Error(`最多创建 ${MAX_GROUPS} 个分组。`);
      const name = groupName(input, this.groups), id = 'g-' + randomUUID();
      await this.parent.writeSettings([['stocks.groups', [...this.groups, { id, name, symbols: [] }]]], false);
      return id;
    });
  }
  async rename(element, value) {
    if (!this.allowed()) return;
    const group = await this.pickGroup(element); if (!group) return;
    const input = typeof value === 'string' ? value : await privateUI.showInputBox({ title: '重命名 A 股分组', value: group.name, validateInput: text => { try { groupName(text, this.groups, group.id); } catch (e) { return e.message; } } });
    if (input === undefined || !this.allowed()) return;
    return this.parent.enqueueSettings(async () => {
      if (!this.allowed() || !this.groups.some(g => g.id === group.id)) return;
      const name = groupName(input, this.groups, group.id);
      await this.parent.writeSettings([['stocks.groups', this.groups.map(g => g.id === group.id ? { ...g, name } : g)]], false);
    });
  }
  async remove(element) {
    if (!this.allowed()) return;
    const group = await this.pickGroup(element); if (!group) return;
    return this.parent.enqueueSettings(async () => {
      if (this.allowed()) await this.parent.writeSettings([['stocks.groups', this.groups.filter(g => g.id !== group.id)]], false);
    });
  }
  async move(element, targetId) {
    if (!this.allowed()) return;
    let symbol = typeof element === 'string' ? element : element?.symbol;
    if (!symbol) symbol = (await privateUI.showQuickPick(this.parent.config.symbols.map(s => ({ label: this.parent.quotes.get(s)?.name || s, description: s, symbol: s })), { title: '选择要移动的 A 股' }))?.symbol;
    if (!this.parent.config.symbols.includes(symbol)) return;
    if (targetId === undefined) {
      const picked = await privateUI.showQuickPick([...this.buckets().map(g => ({ label: g.name, description: g.id === this.idFor(symbol) ? '当前分组' : `${g.symbols.length} 只`, id: g.id })), { label: '＋ 新建分组…', create: true }], { title: '移动到 A 股分组' });
      if (!picked) return;
      targetId = picked.create ? await this.create() : picked.id;
    }
    if (!targetId || !this.allowed() || targetId === this.idFor(symbol)) return;
    return this.parent.enqueueSettings(() => this.moveNow([symbol], targetId));
  }
  async moveNow(symbols, targetId, targetSymbol) {
    if (!this.allowed()) return;
    const p = this.parent, destination = this.bucket(targetId), moving = new Set(symbols);
    if (!destination || !moving.size || symbols.some(s => !p.config.symbols.includes(s))) throw new Error('分组或个股已不存在，请重试。');
    if (targetSymbol && (!destination.symbols.includes(targetSymbol) || moving.has(targetSymbol))) return;
    const buckets = this.buckets().map(g => ({ ...g, symbols: orderedSymbols(g.symbols, p.quotes, p.config.sortBy) }));
    const selected = buckets.flatMap(g => g.symbols).filter(s => moving.has(s));
    const original = buckets.find(g => g.id === targetId).symbols;
    const rest = original.filter(s => !moving.has(s));
    let at = rest.length;
    if (targetSymbol) {
      at = rest.indexOf(targetSymbol);
      if (selected.every(s => original.includes(s)) && original.indexOf(selected[0]) < original.indexOf(targetSymbol)) at++;
    }
    const next = buckets.map(g => ({ ...g, symbols: g.id === targetId ? [...rest.slice(0, at), ...selected, ...rest.slice(at)] : g.symbols.filter(s => !moving.has(s)) }));
    const ordered = next.flatMap(g => g.symbols);
    const groups = next.filter(g => g.custom).map(({ id, name, symbols }) => ({ id, name, symbols }));
    if (JSON.stringify(groups) === JSON.stringify(this.groups) && JSON.stringify(ordered) === JSON.stringify(p.config.symbols) && p.config.sortBy === 'manual') return;
    await p.writeSettings([['stocks.symbols', ordered], ['stocks.groups', groups], ['stocks.sortBy', 'manual']], false);
  }
  reorder(ids, targetId, token) {
    return this.parent.enqueueSettings(async () => {
      if (!this.allowed() || token?.isCancellationRequested || token && !this.parent.config.enabled) return;
      const selected = new Set(ids), order = this.groups.map(g => g.id);
      if (!ids.length || ids.some(id => !order.includes(id)) || selected.has(targetId)) return;
      if (targetId !== undefined && targetId !== UNGROUPED && !order.includes(targetId)) return;
      const rest = this.groups.filter(g => !selected.has(g.id)), moving = this.groups.filter(g => selected.has(g.id));
      let at = rest.length;
      if (targetId && targetId !== UNGROUPED) { at = rest.findIndex(g => g.id === targetId); if (order.indexOf(moving[0].id) < order.indexOf(targetId)) at++; }
      const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
      if (JSON.stringify(next) !== JSON.stringify(this.groups)) await this.parent.writeSettings([['stocks.groups', next]], false);
    });
  }
  shift(id, direction) {
    const index = this.groups.findIndex(g => g.id === id), target = this.groups[index + direction];
    if (index >= 0 && target && [1, -1].includes(direction)) return this.reorder([id], target.id);
  }
}
module.exports = { StockGroups, normalizeGroups, groupName, UNGROUPED, MAX_GROUPS };
