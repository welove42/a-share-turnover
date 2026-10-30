'use strict';
const vscode = require('vscode');
const data = require('./event-calendar-data');
const { LABELS, DAY, beijing, staticEvents, snapshotEvent, parseBls, parseFed, CalendarProvider } = require('./event-calendar');
const { MARKETS, parseHolidays, parseTradingDays, makeTradingEvents, parseEconomic, parseUsEarly, ranges, OnlineCalendar } = require('./online-calendar');
const TYPES = Object.keys(LABELS);
const DYNAMIC = ['fed','nonfarm','cpi'];

class ReminderController {
  constructor(context, { provider = new CalendarProvider(), online = new OnlineCalendar(), now = () => new Date() } = {}) {
    this.context = context; this.provider = provider; this.online = online; this.now = now; this.disposed = false; this.inflight = null; this.records = new Map(); this.onlineErrors = new Map();
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
    const saved = context.globalState.get('eventOnlineCache',{}) || {};
    for (const [key, value] of Object.entries(saved)) {
      try { if (typeof value.text !== 'string' || value.text.length > 1500000 || !Number.isFinite(value.at) || value.at > this.now().getTime()+300000) continue;
        this.records.set(key,{ parsed:this.parseOnline(key,value.text), at:value.at, cached:true });
      } catch { /* 损坏或格式变化的缓存不参与展示 */ }
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
    let entries = [...this.fixedEvents];
    for (const type of DYNAMIC) for (const e of this.sources[type].events) entries.push({ ...e, provenance:this.sources[type].status });
    const records=[...this.records.entries()].sort((a,b)=>a[1].at-b[1].at);
    for (const [key,r] of records) {
      const parts=key.split(':'), mark = `${key.startsWith('market:') || key.startsWith('days:') ? 'Markets Open（marketsopen.today，CC BY 4.0）' : 'Finance Calendar（financecalendar.com）'}${r.cached?'缓存':'接口'} · 北京时间 ${beijing(r.at)}${r.parsed.version?' · 数据版本 '+r.parsed.version:''}${this.onlineErrors.has(key)?' · 更新失败：'+this.onlineErrors.get(key):''}`;
      if (parts[0]==='market') {
        const type=MARKETS[parts[1]], year=parts[2];
        entries=entries.filter(e=>!(e.type===type && e.date.startsWith(year) && !/半日市|提前收盘/.test(e.name)));
        entries.push(...r.parsed.events.map(e=>({...e,provenance:mark})));
      } else if(parts[0]==='days') {
        const year=parts[1], {half,deliveries}=makeTradingEvents(r.parsed,Number(year),this.closed);
        entries=entries.filter(e=>!(e.date.startsWith(year) && (e.type==='delivery' || (e.type==='hkHoliday' && /半日市/.test(e.name)))));
        entries.push(...half.map(e=>({...e,provenance:mark})),...deliveries.map(e=>({...e,provenance:mark+'；按规则推算'})));
      } else if(parts[0]==='economic') {
        for(const type of DYNAMIC) for(const e of r.parsed[type]) {
          entries=entries.filter(old=>!(old.type===type && old.date.slice(0,7)===e.date.slice(0,7)));
          entries.push({...e,provenance:mark});
        }
      } else if(parts[0]==='early') {
        for(const e of r.parsed.events) {
          entries=entries.filter(old=>!(old.type==='usHoliday' && /提前收盘/.test(old.name) && old.date===e.date));
          entries.push({...e,provenance:mark});
        }
      }
    }
    return entries.filter(e => this.categories.includes(e.type)).sort((a,b) => a.when-b.when);
  }
  parseOnline(key,text) {
    const p=key.split(':');
    if(p[0]==='market' && MARKETS[p[1]] && /^20\d\d$/.test(p[2]) && p.length===3) return parseHolidays(text,p[1],Number(p[2]));
    if(p[0]==='days' && /^20\d\d$/.test(p[1]) && p.length===2) return parseTradingDays(text,Number(p[1]));
    if((p[0]==='economic'||p[0]==='early') && /^20\d\d-\d\d-\d\d$/.test(p[1]) && /^20\d\d-\d\d-\d\d$/.test(p[2]) && p.length===3) return p[0]==='economic'?parseEconomic(text,p[1],p[2]):{events:parseUsEarly(text,p[1],p[2])};
    throw new Error('日历缓存键无效');
  }
  async refreshOnline(signal) {
    for(const record of this.records.values()) record.cached=true;
    const year=Number(beijing(this.now().getTime()).slice(0,4)), jobs=[];
    for(const y of [year,year+1]) {
      for(const market of Object.keys(MARKETS)) jobs.push({key:`market:${market}:${y}`,url:this.online.marketUrl(market,y)});
      jobs.push({key:`days:${y}`,url:this.online.tradingUrl(y)});
    }
    for(const [from,to] of ranges(this.now().getTime())) {
      jobs.push({key:`economic:${from}:${to}`,url:this.online.economicUrl(from,to)});
      jobs.push({key:`early:${from}:${to}`,url:this.online.earlyUrl(from,to)});
    }
    const saved = {};
    await Promise.all(jobs.map(async ({key,url}) => {
      try {
        const text=await this.online.fetch(url,signal), parsed=this.parseOnline(key,text), at=this.now().getTime();
        if(signal.aborted||this.disposed) return;
        this.records.set(key,{parsed,at,cached:false}); this.onlineErrors.delete(key); saved[key]={text,at};
      } catch(e) { if(!signal.aborted&&!this.disposed) { this.onlineErrors.set(key,e.message||'请求失败'); const prior=this.records.get(key); if(prior) prior.cached=true; } }
    }));
    if(signal.aborted||this.disposed) return;
    const old=this.context.globalState.get('eventOnlineCache',{}) || {}, all={...old,...saved}, keep={};
    for(const group of ['market:','days:','economic:','early:']) {
      const candidates=Object.entries(all).filter(([key,value])=>key.startsWith(group) && Number.isFinite(value.at)).sort((a,b)=>b[1].at-a[1].at);
      for(const [key,value] of candidates.slice(0,group==='market:'?12:group==='days:'?4:12)) keep[key]=value;
    }
    await this.context.globalState.update('eventOnlineCache',keep).catch(()=>{});
    for(const key of this.records.keys()) if(!keep[key]) this.records.delete(key);
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
      await Promise.all([this.refreshOnline(signal), ...DYNAMIC.map(async type => {
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
      })]);
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
    lines.push('点击查看完整日历和来源。在线数据源可能尚未覆盖下一年；未覆盖时使用已标注的快照，以交易所公告为准。');
    if(this.onlineErrors.size) lines.push(`部分在线日历未更新（${this.onlineErrors.size}项），以事件所标注的缓存或快照为准。`);
    const tooltip = lines.join('\n');
    // 不在每次计时器回调中重写相同内容，避免状态栏悬浮窗闪烁。
    if (this.lastTooltip !== tooltip) { this.item.tooltip = tooltip; this.lastTooltip = tooltip; }
    if (!this.visible) { this.item.show(); this.visible = true; }
  }
  notifyDue() {
    if (!this.notifications) return;
    const now = this.now().getTime(), all = this.events(); let changed = false;
    for (const e of all) {
      if(e.cancelled) continue;
      const remain = e.when-now; if (remain <= 0 || remain > DAY) continue;
      const lead = remain <= 30*60000 ? 30 : 1440, kind = /半日市/.test(e.name)?'half':/提前收盘/.test(e.name)?'early':'event', base=`${e.type}:${e.date}:${kind}`, key = `${base}:${lead}`;
      if (this.notified[key] || this.notified[`${e.id}:${lead}`]) continue;
      this.notified[key] = now; if (lead === 30) this.notified[`${base}:1440`] = now; changed = true;
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
    const items = [{ label:'$(refresh) 刷新日历', description:'财经事件及交易所休市安排每天自动更新，失败使用缓存或内置快照', action:'refresh' },
      { label:'$(info) 数据来源与覆盖', description:'Markets Open · Finance Calendar · 官方日历', detail:`在线接口未覆盖的年份使用快照；交易日期与交割以交易所公告为准。${this.onlineErrors.size ? ' 本次未成功的接口：'+[...this.onlineErrors.keys()].join('、') : ''}`, source:data.SOURCES.cnHoliday },
      ...entries.map(e => ({ label:`$(calendar) ${e.name}`, description:`${beijing(e.when)} 北京${e.allDay ? '（按当地09:30提醒）' : ''}`, detail:`${e.detail} ${e.provenance}`, source:e.source }))];
    const selected = await vscode.window.showQuickPick(items,{ title:'财经大事日历', placeHolder:'选择事件查看官方来源；时间均为北京时间' });
    if (selected?.action === 'refresh' && this.enabled) { await this.refresh(); return this.show(); }
    if (selected?.source) await vscode.env.openExternal(vscode.Uri.parse(selected.source));
  }
  dispose() { this.disposed = true; clearInterval(this.timer); this.abort?.abort(); this.listener.dispose(); this.item.dispose(); }
}
module.exports = { ReminderController };
