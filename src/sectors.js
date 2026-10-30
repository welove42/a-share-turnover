'use strict';
const vscode = require('vscode');
const { requestJson } = require('./http');
const { stockSession, shanghaiClock, POLL_MS } = require('./market');

const CATEGORIES = { industry: { name: '行业', fs: 'm:90+t:2+f:!50' }, concept: { name: '概念', fs: 'm:90+t:3+f:!50' } };
const CONCEPT_POLL_MS = 60000;
function parseSectors(payload, category, now = Date.now()) {
  if (!CATEGORIES[category] || payload?.rc !== 0 || !payload.data?.diff) throw new Error('板块行情返回无效');
  const rows = Object.values(payload.data.diff), seen = new Set(), result = [];
  for (const row of rows) {
    const percent = typeof row.f3 === 'number' ? row.f3 : typeof row.f3 === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(row.f3) ? Number(row.f3) : NaN;
    if (!/^BK\d{4,8}$/.test(row.f12 || '') || typeof row.f14 !== 'string' || !row.f14.trim() || row.f14.length > 40 || /[\x00-\x1f]/.test(row.f14)
      || !Number.isFinite(percent) || !Number.isInteger(row.f124) || row.f124 < 946684800 || row.f124 * 1000 > now + 300000 || seen.has(row.f12)) continue;
    seen.add(row.f12); result.push({ code: row.f12, name: row.f14.trim(), percent, timestamp: row.f124 });
  }
  if (result.length !== 10) throw new Error('板块排名不足十项或行情字段无效');
  result.sort((a, b) => b.percent - a.percent);
  return result;
}
class SectorProvider {
  constructor(request = requestJson) { this.request = request; this.cooldowns = new Map(); }
  resetCooldowns() { this.cooldowns.clear(); }
  async load(category, signal, now = Date.now()) {
    const entry = CATEGORIES[category]; if (!entry) throw new Error('未知板块类型');
    const params = new URLSearchParams({ pn: '1', pz: '10', po: '1', fid: 'f3', fs: entry.fs, fields: 'f12,f14,f3,f124', fltt: '2' });
    let lastError;
    const hosts = ['push2.eastmoney.com', '82.push2.eastmoney.com'];
    const available = hosts.filter(host => (this.cooldowns.get(host) || 0) <= now);
    if (!available.length) throw new Error('板块行情接口暂不可用，等待重试');
    for (const host of available) {
      if (signal?.aborted) throw new Error('请求已取消');
      try {
        const rows = parseSectors(await this.request(`https://${host}/api/qt/clist/get?${params}`, signal, { Referer: 'https://quote.eastmoney.com/' }), category, now);
        this.cooldowns.delete(host); return rows;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error; this.cooldowns.set(host, now + 30000);
      }
    }
    throw lastError || new Error('板块行情接口暂不可用');
  }
}
class SectorsController {
  constructor(context, { provider = new SectorProvider(), now = () => new Date() } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.disposed = false; this.inflight = null; this.abort = null;
    this.lastAttempt = -Infinity; this.generation = 0; this.error = ''; this.retryCount = 0; this.rendered = {}; this.visible = false;
    this.item = vscode.window.createStatusBarItem('aShareTurnover.sectors', vscode.StatusBarAlignment.Right, 98);
    this.item.name = 'A股领涨板块'; this.readConfig(); this.restore();
    this.item.command = 'welove42.aShareTurnover.sectors.refresh';
    this.listener = vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('aShareTurnover.sectors') && !event.affectsConfiguration('aShareTurnover.additionalClosedDates')) return;
      const old = this.category, enabled = this.enabled; this.readConfig();
      if (old !== this.category || !this.enabled) { this.generation++; this.abort?.abort(); }
      if (old !== this.category) { this.rows = null; this.error = ''; this.retryCount = 0; this.provider.resetCooldowns?.(); this.restore(); }
      this.render();
      if (this.enabled && (!enabled || old !== this.category)) void (this.inflight || Promise.resolve()).then(() => this.refresh());
    });
  }
  readConfig() {
    const c = vscode.workspace.getConfiguration('aShareTurnover');
    this.enabled = c.get('sectors.enabled', true); this.category = CATEGORIES[c.get('sectors.category', 'industry')] ? c.get('sectors.category', 'industry') : 'industry';
    this.closedDates = c.get('additionalClosedDates', []);
  }
  restore() {
    const cached = this.context.globalState.get('sectorRankings', {})[this.category] || this.context.globalState.get('sectorRanking', null);
    if (cached?.category !== this.category || !Array.isArray(cached.rows)) return;
    try { this.rows = parseSectors({ rc: 0, data: { diff: cached.rows.map(r => ({ f12: r.code, f14: r.name, f3: r.percent, f124: r.timestamp })) } }, this.category, this.now().getTime()); } catch { /* ignore invalid cache */ }
  }
  start() { this.render(); this.timer = setInterval(() => this.tick(), 1000); if (this.enabled) void this.refresh(); }
  tick() {
    if (this.disposed || !this.enabled) return;
    this.render();
    const trading = stockSession(this.now(), this.closedDates).polling;
    const due = trading ? this.now().getTime() - this.lastAttempt >= (this.category === 'concept' ? CONCEPT_POLL_MS : POLL_MS)
      : this.error && this.retryCount < 5 && this.now().getTime() - this.lastAttempt >= 60000;
    if (!this.inflight && due) void this.refresh();
  }
  retry() {
    if (this.disposed || !this.enabled) return Promise.resolve();
    this.retryCount = 0; this.provider.resetCooldowns?.();
    return (this.inflight || Promise.resolve()).then(() => this.refresh());
  }
  refresh() {
    if (this.disposed || !this.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const abort = this.abort = new AbortController(), generation = this.generation, category = this.category;
    this.lastAttempt = this.now().getTime();
    this.inflight = (async () => {
      try {
        const rows = await this.provider.load(category, abort.signal, this.now().getTime());
        if (abort.signal.aborted || this.disposed || generation !== this.generation) return;
        const newest = Math.max(...rows.map(r => r.timestamp));
        if (this.rows && newest < Math.max(...this.rows.map(r => r.timestamp))) throw new Error('行情时间早于上次结果');
        this.rows = rows; this.error = ''; this.retryCount = 0;
        const saved = this.context.globalState.get('sectorRankings', {});
        await this.context.globalState.update('sectorRankings', { ...saved, [category]: { category, rows } }).catch(() => {});
      } catch (error) { if (!abort.signal.aborted && !this.disposed && generation === this.generation) { this.error = error.message || '获取失败'; this.retryCount++; } }
      finally { this.inflight = null; this.abort = null; if (!this.disposed) this.render(); }
    })();
    return this.inflight;
  }
  render() {
    if (!this.enabled) { if (this.visible) { this.item.hide(); this.visible = false; } return; }
    const clock = stockSession(this.now(), this.closedDates), rows = this.rows, first = rows?.[0];
    const oldest = rows && Math.min(...rows.map(r => r.timestamp)), stamp = oldest ? shanghaiClock(new Date(oldest * 1000)) : null;
    const stale = Boolean(this.error || !stamp || stamp.date !== clock.date || (clock.polling && this.now().getTime() - oldest * 1000 > 120000));
    const format = p => `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
    const text = first ? `板块 ${first.name} ${format(first.percent)}${stale ? ' · 未更新' : ''}` : this.error ? '板块 获取失败' : '板块 待获取';
    const tip = new vscode.MarkdownString(); tip.isTrusted = false;
    tip.appendText(`东方财富${CATEGORIES[this.category].name}板块 · 涨跌幅前十\n${stamp ? `行情时间：${stamp.date} ${stamp.time}（北京，最早报价）` : '尚无可用行情'}${stale && first ? '\n当前为历史或未更新行情' : ''}${this.error ? `\n获取失败：${this.error}` : ''}\n\n`);
    if (rows) rows.forEach((r, i) => tip.appendText(`${i + 1}. ${r.name} ${format(r.percent)}\n`));
    tip.appendText(`\n交易期间每${this.category === 'concept' ? 60 : 10}秒自动更新；点击状态栏重新获取。`);
    if (text !== this.rendered.text) this.item.text = text;
    if (tip.value !== this.rendered.tooltip) this.item.tooltip = tip;
    this.rendered = { text, tooltip: tip.value };
    if (!this.visible) { this.item.show(); this.visible = true; }
  }
  dispose() { this.disposed = true; this.generation++; clearInterval(this.timer); this.abort?.abort(); this.listener.dispose(); this.item.dispose(); }
}
module.exports = { SectorProvider, SectorsController, parseSectors };
