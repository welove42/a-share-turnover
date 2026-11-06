'use strict';
const vscode = require('vscode');
const privateUI = require('./privacy-ui');
const { requestJson, requestBuffer } = require('./http');
const { stockSession, shanghaiClock, POLL_MS } = require('./market');

const CATEGORIES = { industry: { name: '行业', fs: 'm:90+t:2+f:!50' }, concept: { name: '概念', fs: 'm:90+t:3+f:!50' } };
const DIRECTIONS = { gainers: { name: '涨幅前十', label: '领涨', po: '1', icon: 'arrow-up' }, losers: { name: '跌幅前十', label: '领跌', po: '0', icon: 'arrow-down' } };
const compare = direction => direction === 'losers' ? (a, b) => a.percent - b.percent : (a, b) => b.percent - a.percent;
const cacheKey = (category, direction) => direction === 'gainers' ? category : `${category}:${direction}`;
const CONCEPT_POLL_MS = 60000;
const SINA_URLS = { concept: 'https://stocks.sina.cn/sh/fieldranking?type=class&vt=4', industry: 'https://stocks.sina.cn/sh/fieldranking?type=sina&vt=4' };
function parseSinaAll(html, category, now = Date.now()) {
  const prefix = category === 'concept' ? 'gn_' : category === 'industry' ? 'new_' : null;
  if (!prefix) throw new Error('未知板块类型');
  const section = typeof html === 'string' && html.match(/<section\s+class="finlist_mod"[^>]*>([\s\S]*?)<\/section>/i);
  if (!section) throw new Error('新浪概念榜页面格式无效');
  const items = [...section[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
  if (items.length < 10) throw new Error('新浪概念榜不足十项');
  const seen = new Set(), rows = [];
  for (const item of items) {
    const match = item[1].match(/<a\b[^>]*\bboardid=((?:gn_|new_)[a-z0-9_]+)[^>]*>([^<>&]{1,40})<\/a>[\s\S]*?<span\b[^>]*>\s*([+-]?\d+(?:\.\d+)?)%\s*<\/span>/i);
    if (!match || !match[1].toLowerCase().startsWith(prefix) || seen.has(match[1]) || !Number.isFinite(Number(match[3])) || /[\x00-\x1f]/.test(match[2])) throw new Error('新浪板块榜字段无效');
    seen.add(match[1]); rows.push({ code: match[1], name: match[2].trim(), percent: Number(match[3]), timestamp: Math.floor(now / 1000), source: 'sina' });
  }
  if (rows.some((r, i) => !r.name || (i && r.percent > rows[i - 1].percent))) throw new Error('新浪概念榜顺序无效');
  return rows;
}
function selectSina(rows, direction) { return direction === 'losers' ? rows.slice(-10).reverse() : rows.slice(0, 10); }
function parseSina(html, category, now = Date.now(), direction = 'gainers') { return selectSina(parseSinaAll(html, category, now), direction); }
function parseSinaConcept(html, now = Date.now()) { return parseSina(html, 'concept', now); }
function restoreSina(rows, category, now, direction = 'gainers') {
  if (!Array.isArray(rows) || rows.length !== 10) throw new Error('新浪概念榜缓存无效');
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    const validCode = category === 'concept' ? /^gn_[a-z0-9_]+$/i : /^new_[a-z0-9_]+$/i;
    if (r.source !== 'sina' || !validCode.test(r.code || '') || seen.has(r.code) || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 40 || /[\x00-\x1f]/.test(r.name) || !Number.isFinite(r.percent) || !Number.isInteger(r.timestamp) || r.timestamp < 946684800 || r.timestamp * 1000 > now + 300000 || (i && compare(direction)(rows[i - 1], r) > 0)) throw new Error('新浪板块榜缓存无效');
    seen.add(r.code);
  }
  return rows;
}
function parseSectors(payload, category, now = Date.now(), direction = 'gainers') {
  if (!Object.hasOwn(CATEGORIES, category) || !Object.hasOwn(DIRECTIONS, direction) || payload?.rc !== 0 || !payload.data?.diff) throw new Error('板块行情返回无效');
  const rows = Object.values(payload.data.diff), seen = new Set(), result = [];
  for (const row of rows) {
    const percent = typeof row.f3 === 'number' ? row.f3 : typeof row.f3 === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(row.f3) ? Number(row.f3) : NaN;
    if (!/^BK\d{4,8}$/.test(row.f12 || '') || typeof row.f14 !== 'string' || !row.f14.trim() || row.f14.length > 40 || /[\x00-\x1f]/.test(row.f14)
      || !Number.isFinite(percent) || !Number.isInteger(row.f124) || row.f124 < 946684800 || row.f124 * 1000 > now + 300000 || seen.has(row.f12)) continue;
    seen.add(row.f12); result.push({ code: row.f12, name: row.f14.trim(), percent, timestamp: row.f124 });
  }
  if (result.length !== 10) throw new Error('板块排名不足十项或行情字段无效');
  result.sort(compare(direction));
  return result;
}
class SectorProvider {
  constructor(request = requestJson, requestPage = async (url, signal) => (await requestBuffer(url, signal)).toString('utf8')) { this.request = request; this.requestPage = requestPage; this.cooldowns = new Map(); this.sinaCache = new Map(); }
  resetCooldowns() { this.cooldowns.clear(); this.sinaCache.clear(); }
  async load(category, signal, now = Date.now(), direction = 'gainers') {
    if (!Object.hasOwn(CATEGORIES, category)) throw new Error('未知板块类型');
    const entry = CATEGORIES[category];
    if (!Object.hasOwn(DIRECTIONS, direction)) throw new Error('未知排行方向');
    const params = new URLSearchParams({ pn: '1', pz: '10', po: DIRECTIONS[direction].po, fid: 'f3', fs: entry.fs, fields: 'f12,f14,f3,f124', fltt: '2' });
    let lastError;
    // push2his also serves the ranking with the original f124 quote timestamp.
    // It is still an Eastmoney node, so the independent Sina fallback remains last.
    const hosts = ['push2.eastmoney.com', '82.push2.eastmoney.com', 'push2his.eastmoney.com'];
    const available = hosts.filter(host => (this.cooldowns.get(host) || 0) <= now);
    for (const host of available) {
      if (signal?.aborted) throw new Error('请求已取消');
      try {
        const rows = parseSectors(await this.request(`https://${host}/api/qt/clist/get?${params}`, signal, { Referer: 'https://quote.eastmoney.com/' }), category, now, direction);
        this.cooldowns.delete(host); return rows;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error; this.cooldowns.set(host, now + 30000);
      }
    }
    if (SINA_URLS[category]) {
      if (signal?.aborted) throw new Error('请求已取消');
      try {
        const cached = this.sinaCache.get(category);
        if (cached && now >= cached.time && now - cached.time < 60000) return selectSina(cached.rows, direction);
        const rows = parseSinaAll(await this.requestPage(SINA_URLS[category], signal), category, now);
        this.sinaCache.set(category, { time: now, rows }); return selectSina(rows, direction);
      }
      catch (error) { if (signal?.aborted) throw error; lastError = new Error(`东方财富和新浪备用源均不可用：${error.message}`); }
    }
    throw lastError || new Error('板块行情接口暂不可用');
  }
}
class SectorsController {
  constructor(context, { provider = new SectorProvider(), now = () => new Date() } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.disposed = false; this.inflight = null; this.abort = null;
    this.lastAttempt = -Infinity; this.generation = 0; this.error = ''; this.retryCount = 0; this.rendered = {}; this.visible = false;
    this.item = vscode.window.createStatusBarItem('aShareTurnover.sectors', vscode.StatusBarAlignment.Right, 98);
    this.item.name = 'A股板块排行'; this.readConfig(); this.restore();
    this.item.command = 'welove42.aShareTurnover.sectors.menu';
    this.listener = vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('aShareTurnover.sectors') && !event.affectsConfiguration('aShareTurnover.additionalClosedDates')) return;
      const old = this.category, oldDirection = this.direction, enabled = this.enabled; this.readConfig();
      const changed = old !== this.category || oldDirection !== this.direction;
      if (changed || !this.enabled) { this.generation++; this.abort?.abort(); }
      if (changed) { this.rows = null; this.error = ''; this.retryCount = 0; if (old !== this.category) this.provider.resetCooldowns?.(); this.restore(); }
      this.render();
      if (this.enabled && (!enabled || changed)) void (this.inflight || Promise.resolve()).then(() => this.refresh());
    });
  }
  readConfig() {
    const c = vscode.workspace.getConfiguration('aShareTurnover');
    this.enabled = c.get('sectors.enabled', true); this.category = Object.hasOwn(CATEGORIES, c.get('sectors.category', 'industry')) ? c.get('sectors.category', 'industry') : 'industry';
    this.direction = Object.hasOwn(DIRECTIONS, c.get('sectors.direction', 'gainers')) ? c.get('sectors.direction', 'gainers') : 'gainers';
    this.closedDates = c.get('additionalClosedDates', []);
  }
  restore() {
    const cached = this.context.globalState.get('sectorRankings', {})[cacheKey(this.category, this.direction)] || (this.direction === 'gainers' ? this.context.globalState.get('sectorRanking', null) : null);
    if (cached?.category !== this.category || (cached.direction || 'gainers') !== this.direction || !Array.isArray(cached.rows)) return;
    try { this.rows = cached.rows[0]?.source === 'sina' ? restoreSina(cached.rows, this.category, this.now().getTime(), this.direction) : parseSectors({ rc: 0, data: { diff: cached.rows.map(r => ({ f12: r.code, f14: r.name, f3: r.percent, f124: r.timestamp })) } }, this.category, this.now().getTime(), this.direction); } catch { /* ignore invalid cache */ }
  }
  start() { this.render(); this.timer = setInterval(() => this.tick(), 1000); if (this.enabled) void this.refresh(); }
  tick() {
    if (this.disposed || this.hidden || !this.enabled) return;
    this.render();
    const trading = stockSession(this.now(), this.closedDates).polling;
    const due = trading ? this.now().getTime() - this.lastAttempt >= (this.category === 'concept' ? CONCEPT_POLL_MS : POLL_MS)
      : this.error && this.retryCount < 5 && this.now().getTime() - this.lastAttempt >= 60000;
    if (!this.inflight && due) void this.refresh();
  }
  retry() {
    if (this.disposed || this.hidden || !this.enabled) return Promise.resolve();
    this.retryCount = 0; this.provider.resetCooldowns?.();
    return (this.inflight || Promise.resolve()).then(() => this.refresh());
  }
  async showMenu() {
    if (this.disposed || this.hidden || !this.enabled) return;
    const selected = await privateUI.showQuickPick([
      ...Object.entries(CATEGORIES).map(([category, entry]) => ({ label: `${entry.name}板块`, description: category === this.category ? '当前显示' : '', category })),
      ...Object.entries(DIRECTIONS).map(([direction, entry]) => ({ label: `$(${entry.icon}) ${entry.name}`, description: direction === this.direction ? '当前显示' : '', direction })),
      { label: '$(refresh) 立即刷新', action: 'refresh' }
    ], { title: `${CATEGORIES[this.category].name}板块 · ${DIRECTIONS[this.direction].name}`, placeHolder: '切换行业 / 概念、涨幅 / 跌幅榜，也可以手动刷新' });
    if (!selected || this.disposed || this.hidden || !this.enabled) return;
    if (selected.action === 'refresh') return this.retry();
    const key = Object.hasOwn(DIRECTIONS, selected.direction) ? 'sectors.direction' : Object.hasOwn(CATEGORIES, selected.category) ? 'sectors.category' : null;
    const value = key === 'sectors.direction' ? selected.direction : selected.category;
    if (!key || value === (key === 'sectors.direction' ? this.direction : this.category)) return;
    try {
      const config = vscode.workspace.getConfiguration('aShareTurnover');
      const inspected = config.inspect?.(key);
      const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update(key, value, target);
    } catch (error) { await privateUI.showErrorMessage(`切换板块失败：${error.message}`); }
  }
  refresh() {
    if (this.disposed || this.hidden || !this.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const abort = this.abort = new AbortController(), generation = this.generation, category = this.category, direction = this.direction;
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      try {
        const rows = await this.provider.load(category, abort.signal, this.now().getTime(), direction);
        if (abort.signal.aborted || this.disposed || generation !== this.generation) return;
        const newest = Math.max(...rows.map(r => r.timestamp));
        if (this.rows && (this.rows[0].source || 'eastmoney') === (rows[0].source || 'eastmoney') && newest < Math.max(...this.rows.map(r => r.timestamp))) throw new Error('行情时间早于上次结果');
        this.rows = rows; this.error = ''; this.retryCount = 0;
        const saved = this.context.globalState.get('sectorRankings', {});
        await this.context.globalState.update('sectorRankings', { ...saved, [cacheKey(category, direction)]: { category, direction, rows } }).catch(() => {});
      } catch (error) { if (!abort.signal.aborted && !this.disposed && generation === this.generation) { this.error = error.message || '获取失败'; this.retryCount++; } }
      finally { this.inflight = null; this.abort = null; if (!this.disposed) this.render(); }
    })();
    return this.inflight;
  }
  render() {
    if (!this.enabled || this.hidden) { if (this.visible) { this.item.hide(); this.visible = false; } return; }
    const clock = stockSession(this.now(), this.closedDates), rows = this.rows, first = rows?.[0];
    const oldest = rows && Math.min(...rows.map(r => r.timestamp)), stamp = oldest ? shanghaiClock(new Date(oldest * 1000)) : null;
    const sina = first?.source === 'sina';
    const stale = Boolean(this.error || !stamp || stamp.date !== clock.date || (clock.polling && this.now().getTime() - oldest * 1000 > 120000));
    const format = p => `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
    const label = DIRECTIONS[this.direction].label;
    const text = first ? `${label} ${first.name} ${format(first.percent)}${sina ? ' · 参考' : ''}` : `${label} ${this.error ? '获取失败' : '待获取'}`;
    const tip = new vscode.MarkdownString(); tip.isTrusted = false;
    tip.appendText(`${sina ? `新浪${CATEGORIES[this.category].name}板块（备用，分类口径与东方财富不同）` : `东方财富${CATEGORIES[this.category].name}板块`} · ${DIRECTIONS[this.direction].name}\n${sina && stamp ? `获取时间：${stamp.date} ${stamp.time}（北京）；页面未提供行情时间，不保证实时` : stamp ? `行情时间：${stamp.date} ${stamp.time}（北京，最早报价）` : '尚无可用行情'}${stale && first ? '\n当前为历史或未更新行情' : ''}${this.error ? `\n获取失败：${this.error}` : ''}\n\n`);
    if (rows) rows.forEach((r, i) => tip.appendText(`${i + 1}. ${r.name} ${format(r.percent)}\n`));
    if (rows && (this.direction === 'losers' ? rows.some(r => r.percent >= 0) : rows.some(r => r.percent <= 0))) tip.appendText(`\n按涨跌幅从${this.direction === 'losers' ? '低到高' : '高到低'}排列，${this.direction === 'losers' ? '下跌' : '上涨'}板块不足十个时包含其余板块。\n`);
    tip.appendText(`\n交易期间每${this.category === 'concept' ? 60 : 10}秒更新；新浪备用榜最多每60秒获取一次。点击切换板块类型、涨跌榜或刷新。`);
    if (text !== this.rendered.text) this.item.text = text;
    if (tip.value !== this.rendered.tooltip) this.item.tooltip = tip;
    this.rendered = { text, tooltip: tip.value };
    if (!this.visible) { this.item.show(); this.visible = true; }
  }
  setHidden(hidden) {
    this.hidden = hidden; if (hidden) { this.generation++; this.abort?.abort(); }
    this.render();
    if (!hidden && this.enabled) void (this.inflight || Promise.resolve()).then(() => { if (!this.disposed && !this.hidden && this.enabled) return this.refresh(); });
  }
  dispose() { this.disposed = true; this.generation++; clearInterval(this.timer); this.abort?.abort(); this.listener.dispose(); this.item.dispose(); }
}
module.exports = { SectorProvider, SectorsController, parseSectors, parseSinaConcept };
