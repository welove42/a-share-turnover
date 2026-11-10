import type { CalendarEvent } from './calendar';
interface CalendarPick extends vscode.QuickPickItem {
  action?: string;
  source?: string;
}
interface OnlineRecord {
  text: string;
  at: number;
}
import * as vscode from 'vscode';
import * as privateUI from '../../core/ui/privacy';
import * as data from './calendar-data';
import { LABELS, DAY, beijing, staticEvents, snapshotEvent, parseBls, parseFed, CalendarProvider } from './calendar';
import {
  MARKETS,
  parseHolidays,
  parseTradingDays,
  makeTradingEvents,
  parseEconomic,
  parseUsEarly,
  OnlineCalendar
} from './online-calendar';
import { WEEKLY_URL, NYSE_URL, parseWeekly, parseNyseEarly, calendarSource } from './public-calendar';
const TYPES = Object.keys(LABELS);
const DYNAMIC = ['fed', 'nonfarm', 'cpi'];

class ReminderController {
  declare context: any;
  declare provider: CalendarProvider;
  declare online: OnlineCalendar;
  declare now: () => Date;
  declare disposed: boolean;
  declare inflight: any;
  declare records: Map<any, any>;
  declare onlineErrors: Map<any, any>;
  declare sources: {};
  declare notified: any;
  declare item: vscode.StatusBarItem;
  declare listener: vscode.Disposable;
  declare enabled: boolean | undefined;
  declare notifications: boolean | undefined;
  declare categories: string[];
  declare closed: string[];
  declare fixedEvents: CalendarEvent[];
  declare timer: NodeJS.Timeout | undefined;
  declare abort: AbortController | null | undefined;
  declare lastAttempt: number | undefined;
  declare visible: boolean | undefined;
  declare lastTooltip: any;
  declare hidden: any;
  private attempts: Record<string, { next: number; at?: number; error?: string }> = {};

  constructor(
    context,
    { provider = new CalendarProvider(), online = new OnlineCalendar(), now = () => new Date() } = {}
  ) {
    this.context = context;
    this.provider = provider;
    this.online = online;
    this.now = now;
    this.disposed = false;
    this.inflight = null;
    this.records = new Map();
    this.onlineErrors = new Map();
    const attempts = context.globalState.get('eventCalendarAttemptsV2', {}) || {};
    for (const [key, value] of Object.entries<any>(attempts)) {
      if (!Number.isFinite(value?.next) || value.next > now().getTime() + 8 * DAY) continue;
      this.attempts[key] = {
        next: value.next,
        at: Number.isFinite(value.at) ? value.at : undefined,
        error: typeof value.error === 'string' ? value.error.slice(0, 160) : undefined
      };
      if (value.error && value.next > now().getTime()) this.onlineErrors.set(key, value.error);
    }
    this.sources = {};
    this.notified = context.globalState.get('eventNotifications', {}) || {};
    this.item = vscode.window.createStatusBarItem('aShareTurnover.reminders', vscode.StatusBarAlignment.Right, 97);
    this.item.name = '财经大事提醒';
    this.item.command = 'welove42.aShareTurnover.reminders.show';
    this.readConfig();
    const cached = context.globalState.get('eventCalendarCache', {}) || {};
    for (const type of DYNAMIC) {
      const dates = type === 'fed' ? data.FED : type === 'nonfarm' ? data.NONFARM : data.CPI;
      this.sources[type] = {
        events: dates.map((date) => snapshotEvent(type, date)),
        status: `官方快照 ${data.SNAPSHOT_DATE}，未在线核实`
      };
      try {
        const c = cached[type];
        if (
          !c ||
          typeof c.html !== 'string' ||
          c.html.length > 2000000 ||
          !Number.isFinite(c.at) ||
          c.at > this.now().getTime() + 300000
        )
          continue;
        const events = type === 'fed' ? parseFed(c.html) : parseBls(c.html, type);
        this.sources[type] = { events, status: `官方日历缓存，获取于北京时间 ${beijing(c.at)}，尚未重新核实` };
      } catch {
        /* 无效缓存不会覆盖官方快照 */
      }
    }
    const saved = context.globalState.get('eventOnlineCache', {}) || {};
    for (const [key, value] of Object.entries<OnlineRecord>(saved)) {
      try {
        if (
          typeof value.text !== 'string' ||
          value.text.length > 1500000 ||
          !Number.isFinite(value.at) ||
          value.at > this.now().getTime() + 300000
        )
          continue;
        this.records.set(key, { parsed: this.parseOnline(key, value.text), at: value.at, cached: true });
      } catch {
        /* 损坏或格式变化的缓存不参与展示 */
      }
    }
    for (const type of DYNAMIC) {
      const c = cached[type],
        key = `official:${type}`;
      if (
        !c ||
        !Number.isFinite(c.at) ||
        c.at > now().getTime() + 300000 ||
        typeof c.html !== 'string' ||
        c.html.length > 2000000
      )
        continue;
      try {
        if (!this.records.has(key))
          this.records.set(key, { parsed: this.parseOnline(key, c.html), at: c.at, cached: true });
      } catch {
        /* 旧版官方缓存仅在能重新解析时迁移。 */
      }
    }
    this.listener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('aShareTurnover.reminders') &&
        !e.affectsConfiguration('aShareTurnover.additionalClosedDates')
      )
        return;
      const old = this.enabled;
      this.readConfig();
      this.render();
      if (this.enabled && !old) void this.refresh();
    });
  }
  readConfig() {
    const c = vscode.workspace.getConfiguration('aShareTurnover');
    this.enabled = c.get('reminders.enabled', true);
    this.notifications = c.get('reminders.notifications', true);
    const types = c.get('reminders.categories', TYPES);
    this.categories = Array.isArray(types) ? types.filter((x) => TYPES.includes(x)) : TYPES;
    this.closed = c.get('additionalClosedDates', []);
    if (!Array.isArray(this.closed)) this.closed = [];
    this.fixedEvents = staticEvents(this.closed);
  }
  events() {
    let entries = [...this.fixedEvents];
    for (const type of DYNAMIC)
      for (const e of this.sources[type].events) entries.push({ ...e, provenance: this.sources[type].status });
    // 旧第三方缓存只兜底；近期周日历优于旧缓存，刚核实的官方日历最后覆盖。
    const priority = ([key, r]) =>
      key.startsWith('official:')
        ? !this.onlineErrors.has(key) && this.now().getTime() - r.at < DAY
          ? 3
          : 1
        : key === 'weekly'
          ? 2
          : 0;
    const records = [...this.records.entries()].sort((a, b) => priority(a) - priority(b) || a[1].at - b[1].at);
    for (const [key, r] of records) {
      const parts = key.split(':'),
        mark = `${calendarSource(key)} · ${r.cached || this.onlineErrors.has(key) ? '缓存' : '已核实'} · 更新 ${beijing(r.at)} 北京${r.parsed.version ? ' · 版本 ' + r.parsed.version : ''}`;
      if (parts[0] === 'market') {
        const type = MARKETS[parts[1]],
          year = parts[2];
        entries = entries.filter(
          (e) => !(e.type === type && e.date.startsWith(year) && !/半日市|提前收盘/.test(e.name))
        );
        entries.push(...r.parsed.events.map((e) => ({ ...e, provenance: mark })));
      } else if (parts[0] === 'days') {
        const year = parts[1],
          { half, deliveries } = makeTradingEvents(r.parsed, Number(year), this.closed);
        entries = entries.filter(
          (e) =>
            !(e.date.startsWith(year) && (e.type === 'delivery' || (e.type === 'hkHoliday' && /半日市/.test(e.name))))
        );
        entries.push(
          ...half.map((e) => ({ ...e, provenance: mark })),
          ...deliveries.map((e) => ({ ...e, provenance: mark + '；按规则推算' }))
        );
      } else if (parts[0] === 'official' || key === 'weekly') {
        if (key === 'official:nyse')
          entries = entries.filter(
            (e) => !(e.type === 'usHoliday' && /提前收盘/.test(e.name) && r.parsed.years.includes(e.date.slice(0, 4)))
          );
        for (const e of r.parsed.events) {
          entries = entries.filter(
            (old) =>
              !(
                old.type === e.type &&
                (e.type === 'usHoliday'
                  ? old.date === e.date && /提前收盘/.test(old.name)
                  : old.date.slice(0, 7) === e.date.slice(0, 7))
              )
          );
          entries.push({ ...e, provenance: mark });
        }
      } else if (parts[0] === 'economic') {
        for (const type of DYNAMIC)
          for (const e of r.parsed[type]) {
            entries = entries.filter((old) => !(old.type === type && old.date.slice(0, 7) === e.date.slice(0, 7)));
            entries.push({ ...e, provenance: mark });
          }
      } else if (parts[0] === 'early') {
        for (const e of r.parsed.events) {
          entries = entries.filter(
            (old) => !(old.type === 'usHoliday' && /提前收盘/.test(old.name) && old.date === e.date)
          );
          entries.push({ ...e, provenance: mark });
        }
      }
    }
    return entries.filter((e) => this.categories.includes(e.type)).sort((a, b) => a.when - b.when);
  }
  parseOnline(key, text) {
    if (key === 'weekly') return parseWeekly(text);
    if (key === 'official:nyse') return parseNyseEarly(text);
    if (key === 'official:fed') return { events: parseFed(text) };
    if (key === 'official:cpi' || key === 'official:nonfarm') return { events: parseBls(text, key.split(':')[1]) };
    const p = key.split(':');
    if (p[0] === 'market' && MARKETS[p[1]] && /^20\d\d$/.test(p[2]) && p.length === 3)
      return parseHolidays(text, p[1], Number(p[2]));
    if (p[0] === 'days' && /^20\d\d$/.test(p[1]) && p.length === 2) return parseTradingDays(text, Number(p[1]));
    if (
      (p[0] === 'economic' || p[0] === 'early') &&
      /^20\d\d-\d\d-\d\d$/.test(p[1]) &&
      /^20\d\d-\d\d-\d\d$/.test(p[2]) &&
      p.length === 3
    )
      return p[0] === 'economic' ? parseEconomic(text, p[1], p[2]) : { events: parseUsEarly(text, p[1], p[2]) };
    throw new Error('日历缓存键无效');
  }
  async refreshOnline(signal, force = false) {
    const year = Number(beijing(this.now().getTime()).slice(0, 4)),
      jobs: { key: string; url: string }[] = [];
    for (const y of [year, year + 1]) {
      for (const market of Object.keys(MARKETS))
        jobs.push({ key: `market:${market}:${y}`, url: this.online.marketUrl(market, y) });
      jobs.push({ key: `days:${y}`, url: this.online.tradingUrl(y) });
    }
    // Finance Calendar 已要求认证，停用其网络请求；保留旧记录仅用于离线兜底。
    jobs.push({ key: 'weekly', url: WEEKLY_URL }, { key: 'official:nyse', url: NYSE_URL });
    for (const type of DYNAMIC) jobs.push({ key: `official:${type}`, url: data.SOURCES[type] });
    const saved: Record<string, OnlineRecord> = {};
    await Promise.all(
      jobs.map(async ({ key, url }) => {
        const priorAttempt = this.attempts[key];
        // 失败冷却不能被重启、老板键恢复或反复点击刷新绕过。
        if (priorAttempt?.next > this.now().getTime() && (!force || priorAttempt.error)) return;
        if (priorAttempt?.at && this.now().getTime() - priorAttempt.at < 15 * 60000) return;
        try {
          const text = await (key.startsWith('official:') ? this.provider : this.online).fetch(url, signal),
            parsed = this.parseOnline(key, text),
            at = this.now().getTime();
          if (key === 'weekly' && (!('to' in parsed) || parsed.to < at - 7 * DAY || parsed.from > at + 7 * DAY))
            throw new Error('周日历尚未覆盖当前日期');
          if (signal.aborted || this.disposed) return;
          this.records.set(key, { parsed, at, cached: false });
          this.onlineErrors.delete(key);
          this.attempts[key] = { next: at + DAY, at };
          saved[key] = { text, at };
        } catch (e) {
          if (!signal.aborted && !this.disposed) {
            const message = (e.message || '请求失败').slice(0, 160);
            const denied = [401, 403, 404].includes(e.statusCode);
            const coverage = /未覆盖|未经核实|未知.*状态/.test(message);
            this.onlineErrors.set(key, message);
            this.attempts[key] = {
              next: this.now().getTime() + (denied || coverage ? 7 * DAY : DAY / 4),
              at: this.now().getTime(),
              error: message
            };
            const prior = this.records.get(key);
            if (prior) prior.cached = true;
          }
        }
      })
    );
    if (signal.aborted || this.disposed) return;
    const old = { ...(this.context.globalState.get('eventOnlineCache', {}) || {}) };
    const legacy = this.context.globalState.get('eventCalendarCache', {}) || {};
    for (const type of DYNAMIC) {
      const key = `official:${type}`;
      if (!old[key] && this.records.has(key) && legacy[type])
        old[key] = { text: legacy[type].html, at: legacy[type].at };
    }
    const all = { ...old, ...saved },
      keep = {};
    for (const group of ['market:', 'days:', 'economic:', 'early:', 'official:', 'weekly']) {
      const candidates = Object.entries<OnlineRecord>(all)
        .filter(([key, value]) => key.startsWith(group) && Number.isFinite(value.at))
        .sort((a, b) => b[1].at - a[1].at);
      for (const [key, value] of candidates.slice(0, group === 'market:' ? 12 : group === 'days:' ? 4 : 12))
        keep[key] = value;
    }
    await this.context.globalState.update('eventOnlineCache', keep).catch(() => {});
    const activeKeys = new Set(jobs.map((j) => j.key));
    this.attempts = Object.fromEntries(Object.entries(this.attempts).filter(([key]) => activeKeys.has(key)));
    await this.context.globalState.update('eventCalendarAttemptsV2', this.attempts).catch(() => {});
    for (const key of this.records.keys()) if (!keep[key]) this.records.delete(key);
  }
  start() {
    this.render();
    this.tick();
    this.timer = setInterval(() => this.tick(), 60000);
    if (this.enabled) void this.refresh();
  }
  tick() {
    if (this.disposed || this.hidden || !this.enabled) return;
    this.render();
    this.notifyDue();
    if (!this.inflight && this.now().getTime() - (this.lastAttempt || 0) >= DAY / 4) void this.refresh();
  }
  async refresh(force = false) {
    if (this.inflight || this.disposed || this.hidden || !this.enabled) return this.inflight;
    this.abort = new AbortController();
    this.lastAttempt = this.now().getTime();
    const signal = this.abort.signal;
    this.inflight = (async () => {
      await this.refreshOnline(signal, force);
      if (!signal.aborted && !this.disposed) {
        this.render();
        this.notifyDue();
      }
    })().finally(() => {
      this.inflight = null;
      this.abort = null;
    });
    return this.inflight;
  }
  render() {
    if (!this.enabled || this.hidden) {
      if (this.visible) this.item.hide();
      this.visible = false;
      return;
    }
    const now = this.now().getTime(),
      future = this.events().filter((e) => (e.end || e.when) >= now),
      next = future[0];
    const remaining = next && next.when - now;
    const countdown =
      remaining <= 0
        ? '今日'
        : remaining <= DAY
          ? `${Math.ceil(remaining / 3600000)}小时`
          : `${Math.ceil(remaining / DAY)}天`;
    const text = next ? `$(calendar) ${next.name} ${countdown}` : '$(calendar) 大事';
    if (this.item.text !== text) this.item.text = text;
    const lines = future
      .slice(0, 6)
      .map((e) => `${beijing(e.when)} 北京${e.allDay ? '（按当地09:30提醒）' : ''} · ${e.name} · ${e.provenance}`);
    lines.push('点击查看完整日历和来源。在线数据源可能尚未覆盖下一年；未覆盖时使用已标注的快照，以交易所公告为准。');
    if (future.slice(0, 6).some((e) => /缓存|快照/.test(e.provenance || '')))
      lines.push('部分日期使用缓存或快照，来源与更新时间已标注；点击可查看更新详情。');
    const tooltip = lines.join('\n');
    // 不在每次计时器回调中重写相同内容，避免状态栏悬浮窗闪烁。
    if (this.lastTooltip !== tooltip) {
      this.item.tooltip = tooltip;
      this.lastTooltip = tooltip;
    }
    if (!this.visible) {
      this.item.show();
      this.visible = true;
    }
  }
  notifyDue() {
    if (this.hidden || !this.notifications) return;
    const now = this.now().getTime(),
      all = this.events();
    let changed = false;
    for (const e of all) {
      if (e.cancelled) continue;
      const remain = e.when - now;
      if (remain <= 0 || remain > DAY) continue;
      const lead = remain <= 30 * 60000 ? 30 : 1440,
        kind = /半日市/.test(e.name) ? 'half' : /提前收盘/.test(e.name) ? 'early' : 'event',
        base = `${e.type}:${e.date}:${kind}`,
        key = `${base}:${lead}`;
      if (this.notified[key] || this.notified[`${e.id}:${lead}`]) continue;
      this.notified[key] = now;
      if (lead === 30) this.notified[`${base}:1440`] = now;
      changed = true;
      const warning = /快照|缓存|失败/.test(e.provenance || '') ? `（${e.provenance}，请核对）` : '';
      void vscode.window.showInformationMessage(
        `财经大事：${e.name}，北京时间 ${beijing(e.when)}${e.allDay ? '（按当地09:30提醒）' : ''}，${lead === 30 ? '不足30分钟' : '不足24小时'}。${warning}`
      );
    }
    if (changed) {
      for (const key of Object.keys(this.notified)) if (this.notified[key] < now - 90 * DAY) delete this.notified[key];
      void this.context.globalState.update('eventNotifications', this.notified);
    }
  }
  async show() {
    const now = this.now().getTime(),
      entries = this.events().filter((e) => (e.end || e.when) >= now);
    const items = [
      {
        label: '$(refresh) 刷新日历',
        description: '财经事件及交易所休市安排每天自动更新，失败使用缓存或内置快照',
        action: 'refresh'
      },
      {
        label: '$(info) 数据来源与覆盖',
        description: '美联储 / NYSE / BLS · Forex Factory（本周）· Markets Open',
        detail:
          '周日历仅覆盖本周，远期沿用官方日历或标注的缓存/快照。每天自动更新；网络失败冷却6小时，拒绝访问或年份未覆盖冷却7天。' +
          [...new Set([...this.onlineErrors].map(([key, error]) => `${calendarSource(key)}：${error}`))]
            .map((s) => ' ' + s + '。')
            .join(''),
        source: data.SOURCES.cnHoliday
      },
      ...entries.map((e) => ({
        label: `$(calendar) ${e.name}`,
        description: `${beijing(e.when)} 北京${e.allDay ? '（按当地09:30提醒）' : ''}`,
        detail: `${e.detail} ${e.provenance}`,
        source: e.source
      }))
    ];
    const selected = await privateUI.showQuickPick<CalendarPick>(items, {
      title: '财经大事日历',
      placeHolder: '选择事件查看官方来源；时间均为北京时间'
    });
    if (selected?.action === 'refresh' && this.enabled) {
      await this.refresh(true);
      return this.show();
    }
    if (selected?.source) await vscode.env.openExternal(vscode.Uri.parse(selected.source));
  }
  setHidden(hidden, since) {
    this.hidden = hidden;
    if (hidden) this.abort?.abort();
    else if (Number.isFinite(since)) {
      const now = this.now().getTime();
      for (const e of this.events()) {
        if (e.cancelled || e.when <= now) continue;
        const kind = /半日市/.test(e.name) ? 'half' : /提前收盘/.test(e.name) ? 'early' : 'event';
        for (const lead of [1440, 30])
          if (e.when - lead * 60000 <= now) this.notified[`${e.type}:${e.date}:${kind}:${lead}`] = now;
      }
      void this.context.globalState.update('eventNotifications', this.notified);
    }
    this.render();
    if (!hidden && this.enabled)
      void (this.inflight || Promise.resolve()).then(() => {
        if (!this.disposed && !this.hidden && this.enabled) return this.refresh();
      });
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.abort?.abort();
    this.listener.dispose();
    this.item.dispose();
  }
}
export { ReminderController };
