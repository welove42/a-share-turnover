'use strict';
const vscode = require('vscode');
const data = require('./event-calendar-data');
const { LABELS, DAY, beijing, staticEvents, snapshotEvent, parseBls, parseFed, CalendarProvider } = require('./event-calendar');
const TYPES = Object.keys(LABELS);
const DYNAMIC = ['fed','nonfarm','cpi'];

class ReminderController {
  constructor(context, { provider = new CalendarProvider(), now = () => new Date() } = {}) {
    this.context = context; this.provider = provider; this.now = now; this.disposed = false; this.inflight = null;
    this.sources = {}; this.notified = context.globalState.get('eventNotifications', {}) || {};
    this.item = vscode.window.createStatusBarItem('aShareTurnover.reminders',vscode.StatusBarAlignment.Right,97);
    this.item.name = '财经大事提醒'; this.item.command = 'welove42.aShareTurnover.reminders.show';
    this.readConfig();
    const cached = context.globalState.get('eventCalendarCache', {}) || {};
    for (const type of DYNAMIC) {
      const dates = type === 'fed' ? data.FED : type === 'nonfarm' ? data.NONFARM : data.CPI;
      this.sources[type] = { events: dates.map(date => snapshotEvent(type,date)), status:`官方快照 ${data.SNAPSHOT_DATE}，未在线核实` };
      try {
        const c = cached[type];
        if (!c || typeof c.html !== 'string' || c.html.length > 2000000 || !Number.isFinite(c.at) || c.at > this.now().getTime()+300000) continue;
        const events = type === 'fed' ? parseFed(c.html) : parseBls(c.html,type);
        this.sources[type] = { events, status:`官方日历缓存，获取于北京时间 ${beijing(c.at)}，尚未重新核实` };
      } catch { /* 无效缓存不会覆盖官方快照 */ }
    }
    this.listener = vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('aShareTurnover.reminders') && !e.affectsConfiguration('aShareTurnover.additionalClosedDates')) return;
      const old = this.enabled; this.readConfig(); this.render();
      if (this.enabled && !old) void this.refresh();
    });
  }
  readConfig() {
    const c = vscode.workspace.getConfiguration('aShareTurnover');
    this.enabled = c.get('reminders.enabled',true); this.notifications = c.get('reminders.notifications',true);
    const types = c.get('reminders.categories',TYPES); this.categories = Array.isArray(types) ? types.filter(x => TYPES.includes(x)) : TYPES;
    this.closed = c.get('additionalClosedDates',[]); if (!Array.isArray(this.closed)) this.closed = [];
    this.fixedEvents = staticEvents(this.closed);
  }
  events() {
    const entries = [...this.fixedEvents];
    for (const type of DYNAMIC) for (const e of this.sources[type].events) entries.push({ ...e, provenance:this.sources[type].status });
    return entries.filter(e => this.categories.includes(e.type)).sort((a,b) => a.when-b.when);
  }
  start() { this.render(); this.tick(); this.timer = setInterval(() => this.tick(),60000); if (this.enabled) void this.refresh(); }
  tick() {
    if (this.disposed || !this.enabled) return;
    this.render(); this.notifyDue();
    if (!this.inflight && this.now().getTime()-(this.lastAttempt || 0) >= DAY) void this.refresh();
  }
  async refresh() {
    if (this.inflight || this.disposed || !this.enabled) return this.inflight;
    this.abort = new AbortController(); this.lastAttempt = this.now().getTime();
    const signal = this.abort.signal;
    this.inflight = (async () => {
      const cache = { ...(this.context.globalState.get('eventCalendarCache',{}) || {}) };
      await Promise.all(DYNAMIC.map(async type => {
        try {
          // 只持久化可重新解析的官方原文，避免把损坏缓存当作可信日历。
          const html = await this.provider.fetch(data.SOURCES[type],signal);
          const events = type === 'fed' ? parseFed(html) : parseBls(html,type);
          if (signal.aborted || this.disposed) return;
          const at = this.now().getTime(); cache[type] = { html, at };
          this.sources[type] = { events, status:`官方日历在线核实：北京时间 ${beijing(at)}` };
        } catch (error) {
          if (!signal.aborted && !this.disposed) this.sources[type].status = this.sources[type].status.replace(/；更新失败.*$/, '') + `；更新失败：${error.message || '请求失败'}`;
        }
      }));
      if (!signal.aborted && !this.disposed) { await this.context.globalState.update('eventCalendarCache',cache).catch(() => {}); this.render(); this.notifyDue(); }
    })().finally(() => { this.inflight = null; this.abort = null; });
    return this.inflight;
  }
  render() {
    if (!this.enabled) { if (this.visible) this.item.hide(); this.visible = false; return; }
    const now = this.now().getTime(), future = this.events().filter(e => (e.end || e.when) >= now), next = future[0];
    const remaining = next && next.when-now;
    const countdown = remaining <= 0 ? '今日' : remaining <= DAY ? `${Math.ceil(remaining/3600000)}小时` : `${Math.ceil(remaining/DAY)}天`;
    const text = next ? `$(calendar) ${next.name} ${countdown}` : '$(calendar) 大事';
    if (this.item.text !== text) this.item.text = text;
    const lines = future.slice(0,6).map(e => `${beijing(e.when)} 北京${e.allDay ? '（按当地09:30提醒）' : ''} · ${e.name} · ${e.provenance}`);
    lines.push('点击查看完整日历和来源。', 'A股、港股休市公告覆盖 2026 年；美股覆盖 2026–2028 年。未来年份及临时调整以交易所公告为准。');
    const tooltip = lines.join('\n');
    // 不在每次计时器回调中重写相同内容，避免状态栏悬浮窗闪烁。
    if (this.lastTooltip !== tooltip) { this.item.tooltip = tooltip; this.lastTooltip = tooltip; }
    if (!this.visible) { this.item.show(); this.visible = true; }
  }
  notifyDue() {
    if (!this.notifications) return;
    const now = this.now().getTime(), all = this.events(); let changed = false;
    for (const e of all) {
      const remain = e.when-now; if (remain <= 0 || remain > DAY) continue;
      const lead = remain <= 30*60000 ? 30 : 1440, key = `${e.id}:${lead}`;
      if (this.notified[key]) continue;
      this.notified[key] = now; if (lead === 30) this.notified[`${e.id}:1440`] = now; changed = true;
      const warning = /快照|缓存|失败/.test(e.provenance || '') ? `（${e.provenance}，请核对）` : '';
      void vscode.window.showInformationMessage(`财经大事：${e.name}，北京时间 ${beijing(e.when)}${e.allDay ? '（按当地09:30提醒）' : ''}，${lead === 30 ? '不足30分钟' : '不足24小时'}。${warning}`);
    }
    if (changed) {
      for (const key of Object.keys(this.notified)) if (this.notified[key] < now-90*DAY) delete this.notified[key];
      void this.context.globalState.update('eventNotifications',this.notified);
    }
  }
  async show() {
    const now = this.now().getTime(), entries = this.events().filter(e => (e.end || e.when) >= now);
    const items = [{ label:'$(refresh) 刷新官方日历', description:'美联储、美国非农和 CPI；交易所休市日历使用内置公告快照', action:'refresh' },
      { label:'$(info) 数据覆盖与说明', description:'A股、港股：2026；美股：2026–2028', detail:'休市日期和交割规则以交易所公告为准；官方数据可能调整。点击查看交易所公告。', source:data.SOURCES.cnHoliday },
      ...entries.map(e => ({ label:`$(calendar) ${e.name}`, description:`${beijing(e.when)} 北京${e.allDay ? '（按当地09:30提醒）' : ''}`, detail:`${e.detail} ${e.provenance}`, source:e.source }))];
    const selected = await vscode.window.showQuickPick(items,{ title:'财经大事日历', placeHolder:'选择事件查看官方来源；时间均为北京时间' });
    if (selected?.action === 'refresh' && this.enabled) { await this.refresh(); return this.show(); }
    if (selected?.source) await vscode.env.openExternal(vscode.Uri.parse(selected.source));
  }
  dispose() { this.disposed = true; clearInterval(this.timer); this.abort?.abort(); this.listener.dispose(); this.item.dispose(); }
}
module.exports = { ReminderController };
