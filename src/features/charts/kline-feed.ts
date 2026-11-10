import { requestJson } from '../../core/network/http';
import { normalizeDate, timeToMinute } from '../turnover/market';

type Source = 'eastmoney' | 'tencent' | 'sohu';
type Mode = 'daily' | 'weekly' | 'monthly' | 'm1' | 'm5' | 'm15' | 'm30' | 'm60';
const PERIOD = { daily: 'day', weekly: 'week', monthly: 'month' };
const KLT = { daily: 101, weekly: 102, monthly: 103, m1: 1, m5: 5, m15: 15, m30: 30, m60: 60 };
const STORAGE = 'sharedKlineCacheV1';
const DAY = 86400000;
export interface KlineResult {
  payload: any;
  source: string;
  sourceId: string;
  fetchedAt: number;
  stale?: boolean;
  warning?: string;
}
interface Options {
  end?: string;
  sourceId?: string;
  priority?: number;
}
interface Flight {
  key: string;
  controller: AbortController;
  priority: number;
  users: Set<object>;
  promise: Promise<KlineResult>;
}
const cancelled = () => Object.assign(new Error('K线请求已取消'), { name: 'AbortError' });
const rowsOf = (node: any, period: string) =>
  Array.isArray(node?.['qfq' + period]) && node['qfq' + period].length
    ? node['qfq' + period]
    : node?.[period] || node?.['qfq' + period];
const badData = (message: string) => Object.assign(new Error(message), { invalidData: true });
const number = (value: unknown) => {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    String(value).trim() === '' ||
    !Number.isFinite(Number(value))
  )
    throw badData('K线数值缺失');
  return Number(value);
};

/** 不执行网关校验脚本。独立数据源转换为同一字段结构，但保留来源和复权身份。 */
export class KlineFeed {
  private cache = new Map<string, KlineResult>();
  private flights = new Map<string, Flight>();
  private failures = new Map<Source, { until: number; count: number }>();
  private misses = new Map<string, number>();
  private queue: Array<{
    flight: Flight;
    run: () => Promise<any>;
    resolve: (v: any) => void;
    reject: (e: unknown) => void;
  }> = [];
  private active = 0;
  private lastStart = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private storage?: { get(key: string, fallback?: any): any; update(key: string, value: any): Thenable<void> };
  disposed = false;
  constructor(
    private request = requestJson,
    private now = () => Date.now(),
    private gap = 750
  ) {}

  attach(storage: NonNullable<KlineFeed['storage']>) {
    this.storage = storage;
    const rows = storage.get(STORAGE, []);
    if (Array.isArray(rows))
      for (const row of rows.slice(0, 40)) {
        try {
          const [symbol, mode, end] = String(row.key).split('|');
          if (
            end ||
            !this.validInput(symbol, mode) ||
            !Number.isFinite(row.value?.fetchedAt) ||
            row.value.fetchedAt > this.now() + 300000 ||
            this.now() - row.value.fetchedAt > 7 * DAY
          )
            continue;
          if (!/^(eastmoney|tencent|sohu):(qfq|raw)$/.test(row.value.sourceId || '')) continue;
          this.validate(row.value.payload, symbol, mode as Mode, false);
          this.cache.set(row.key, row.value);
        } catch {
          /* 损坏缓存不能变成行情。 */
        }
      }
    const failures = storage.get('sharedKlineCooldownV1', {}) || {};
    for (const source of ['eastmoney', 'tencent', 'sohu'] as Source[]) {
      const f = failures[source];
      if (
        f &&
        Number.isFinite(f.until) &&
        f.until > this.now() &&
        f.until <= this.now() + DAY &&
        Number.isInteger(f.count)
      )
        this.failures.set(source, f);
    }
  }
  private validInput(symbol: string, mode: string) {
    return /^(?:(?:sh|sz|bj)\d{6}|hk\d{5})$/.test(symbol) && Object.hasOwn(KLT, mode);
  }
  async load(symbol: string, mode: Mode | string, signal?: AbortSignal, options: Options = {}): Promise<KlineResult> {
    if (this.disposed || signal?.aborted) throw cancelled();
    if (!this.validInput(symbol, mode)) throw new Error('K线代码或周期无效');
    if (options.end) normalizeDate(options.end.replaceAll('-', ''));
    if (options.sourceId && !/^(eastmoney|tencent|sohu):(qfq|raw)$/.test(options.sourceId))
      throw new Error('历史数据来源无效');
    // 最新历史统一获取240根；列表只取末尾样本，和详情/AI共享同一缓存及进行中的请求。
    const key = [symbol, mode, options.end || '', options.sourceId || ''].join('|');
    const prior = this.cache.get(key),
      ttl = options.end ? DAY : mode.startsWith('m') && mode !== 'monthly' ? 60000 : 300000;
    const sameDay =
      prior &&
      new Date(prior.fetchedAt + 8 * 3600000).toISOString().slice(0, 10) ===
        new Date(this.now() + 8 * 3600000).toISOString().slice(0, 10);
    if (prior && (options.end || sameDay) && this.now() - prior.fetchedAt < ttl) return structuredClone(prior);
    if ((this.misses.get(key) || 0) > this.now()) {
      if (prior && this.now() - prior.fetchedAt < 7 * DAY) return this.stale(prior);
      throw new Error('K线来源暂不可用，已暂停重复请求，请稍后刷新');
    }
    let flight = this.flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      flight = {
        key,
        controller: new AbortController(),
        priority: options.priority ?? 0,
        users: new Set(),
        promise: undefined!
      };
      const created = flight;
      created.promise = Promise.resolve()
        .then(() => this.fetch(created, symbol, mode as Mode, options, prior))
        .finally(() => {
          if (this.flights.get(key) === created) this.flights.delete(key);
        });
      this.flights.set(key, created);
    }
    flight.priority = Math.min(flight.priority, options.priority ?? 0);
    const current = flight,
      user = {};
    current.users.add(user);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, result?: KlineResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        current.users.delete(user);
        if (!current.users.size) current.controller.abort();
        if (error) reject(error);
        else resolve(structuredClone(result!));
      };
      const abort = () => finish(cancelled());
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      current.promise.then(
        (result) => finish(undefined, result),
        (error) => finish(error)
      );
    });
  }
  private stale(prior: KlineResult): KlineResult {
    return { ...structuredClone(prior), stale: true, warning: '在线K线暂不可用，显示上次成功缓存；请核对数据日期' };
  }
  private async fetch(flight: Flight, symbol: string, mode: Mode, options: Options, prior?: KlineResult) {
    const sources: Source[] = options.sourceId
      ? [options.sourceId.split(':')[0] as Source]
      : [
          'eastmoney',
          'tencent',
          ...(/^(?:sh6\d{5}|sz(?:00|30)\d{4})$/.test(symbol) && Object.hasOwn(PERIOD, mode) ? ['sohu' as Source] : [])
        ];
    const errors: string[] = [];
    for (const source of sources) {
      if (flight.controller.signal.aborted) throw cancelled();
      try {
        const value = await this.schedule(flight, async () => {
          // 排队中的请求也检查熔断，第一笔501后不能继续把整张自选列表打到该源。
          if ((this.failures.get(source)?.until || 0) > this.now())
            throw Object.assign(new Error(`${source}冷却中`), { cooling: true });
          const payload = await this.read(source, symbol, mode, options.end, flight.controller.signal);
          this.validate(payload, symbol, mode, Boolean(options.end));
          return payload;
        });
        const node = value.data[symbol],
          period = PERIOD[mode] || mode,
          rows = rowsOf(node, period);
        const adjusted = rows === node['qfq' + period];
        const sourceId = source + ':' + (adjusted ? 'qfq' : 'raw');
        if (options.sourceId && sourceId !== options.sourceId) throw badData('历史复权口径变更，请刷新图表');
        const payload = {
          code: 0,
          data: {
            [symbol]: {
              [(adjusted ? 'qfq' : '') + period]: rows.slice(options.end ? -640 : -240).map((row) => row.slice(0, 11)),
              qt: { [symbol]: Array.isArray(node.qt?.[symbol]) ? node.qt[symbol].slice(0, 150) : [] }
            }
          }
        };
        const result = {
          payload,
          source: { eastmoney: '东方财富', tencent: '腾讯行情', sohu: '搜狐财经' }[source],
          sourceId,
          fetchedAt: this.now()
        };
        // 另一个并发请求刚触发的冷却不能被此前已经在途的成功请求撤销。
        if ((this.failures.get(source)?.until || 0) <= this.now()) this.failures.delete(source);
        this.misses.delete(flight.key);
        if (flight.controller.signal.aborted) throw cancelled();
        this.cache.delete(flight.key);
        this.cache.set(flight.key, result);
        while (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value!);
        this.save();
        return result;
      } catch (error) {
        if (flight.controller.signal.aborted || error.name === 'AbortError') throw cancelled();
        if (!error.cooling && !error.invalidData) {
          const count = Math.min(5, (this.failures.get(source)?.count || 0) + 1);
          const blocked =
            [401, 403, 429, 501].includes(error.statusCode) || /HTTP (?:401|403|429|501)\b/.test(error.message || '');
          this.failures.set(source, {
            until: this.now() + Math.min(3600000, (blocked ? 600000 : 60000) * 2 ** (count - 1)),
            count
          });
          this.save();
        }
        errors.push(`${source}：${error.message || '请求失败'}`);
      }
    }
    this.misses.set(flight.key, this.now() + 60000);
    while (this.misses.size > 160) this.misses.delete(this.misses.keys().next().value!);
    if (prior && this.now() - prior.fetchedAt < 7 * DAY) return this.stale(prior);
    throw new Error(`K线数据暂不可用，已暂停重复请求（${errors.join('；')}）`);
  }
  private schedule(flight: Flight, run: () => Promise<any>) {
    return new Promise<any>((resolve, reject) => {
      this.queue.push({ flight, run, resolve, reject });
      this.pump();
    });
  }
  private pump() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    for (const job of this.queue.filter((j) => j.flight.controller.signal.aborted)) job.reject(cancelled());
    this.queue = this.queue.filter((j) => !j.flight.controller.signal.aborted);
    if (this.active >= 2 || !this.queue.length) return;
    const wait = Math.max(0, this.lastStart + this.gap - this.now());
    if (wait) {
      this.timer = setTimeout(() => this.pump(), wait);
      return;
    }
    this.queue.sort((a, b) => a.flight.priority - b.flight.priority);
    const job = this.queue.shift()!;
    this.active++;
    this.lastStart = this.now();
    void Promise.resolve()
      .then(() => {
        if (job.flight.controller.signal.aborted) throw cancelled();
        return job.run();
      })
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active--;
        this.pump();
      });
    if (this.queue.length) this.timer = setTimeout(() => this.pump(), this.gap);
  }
  private async read(source: Source, symbol: string, mode: Mode, end: string | undefined, signal: AbortSignal) {
    const limit = end ? 640 : 240,
      period = PERIOD[mode] || mode;
    if (source === 'tencent') {
      const url = Object.hasOwn(PERIOD, mode)
        ? `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${period},,${end || ''},${limit},qfq`
        : `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},${mode},,240`;
      return this.request(url, signal);
    }
    const rows: any[] = [],
      qt: any[] = [];
    let adjusted = true;
    if (source === 'eastmoney') {
      const market = symbol.startsWith('sh') ? 1 : symbol.startsWith('hk') ? 116 : 0;
      const p = await this.request(
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${symbol.slice(2)}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${KLT[mode]}&fqt=${Object.hasOwn(PERIOD, mode) ? 1 : 0}&end=${end?.replaceAll('-', '') || '20500101'}&lmt=${limit}`,
        signal,
        { Referer: 'https://quote.eastmoney.com/' }
      );
      if (
        p?.rc !== 0 ||
        p.data?.code !== symbol.slice(2) ||
        p.data?.market !== market ||
        !Array.isArray(p.data?.klines)
      )
        throw badData('东方财富未返回匹配的K线');
      qt[1] = p.data.name;
      qt[2] = symbol.slice(2);
      if (/^sh000\d{3}$/.test(symbol) || /^sz399\d{3}$/.test(symbol)) adjusted = false;
      for (const raw of p.data.klines) {
        if (typeof raw !== 'string') throw badData('东方财富K线格式异常');
        const f = raw.split(',');
        if (f.length < 6) throw badData('东方财富K线字段缺失');
        const time = Object.hasOwn(PERIOD, mode) ? normalizeDate(f[0].replaceAll('-', '')) : f[0].replace(/[- :]/g, '');
        // 下游腾讯解析器对科创板按股转手，这里反向适配；东方财富A股K线本身以手计。
        const volume = number(f[5]) * (/^sh68[89]\d{3}$/.test(symbol) ? 100 : 1);
        rows.push([time, ...f.slice(1, 5).map(number), volume, ...f.slice(6)]);
      }
    } else {
      const code = `cn_${symbol.slice(2)}`;
      const p = await this.request(
        `https://q.stock.sohu.com/hisHq?code=${code}&start=19900101&end=${end?.replaceAll('-', '') || '20500101'}&stat=1&order=D&period=${{ daily: 'd', weekly: 'w', monthly: 'm' }[mode]}`,
        signal,
        { Referer: 'https://q.stock.sohu.com/', 'User-Agent': 'Mozilla/5.0' }
      );
      const v = Array.isArray(p) && p[0];
      if (v?.status !== 0 || v.code !== code || !Array.isArray(v.hq)) throw badData('搜狐未返回匹配的K线');
      adjusted = false;
      for (const f of v.hq.slice(0, limit).reverse()) {
        if (!Array.isArray(f) || f.length < 8) throw badData('搜狐K线字段缺失');
        rows.push([
          normalizeDate(f[0].replaceAll('-', '')),
          number(f[1]),
          number(f[2]),
          number(f[6]),
          number(f[5]),
          number(f[7]) * (/^sh68[89]\d{3}$/.test(symbol) ? 100 : 1),
          null,
          null,
          null,
          null,
          typeof f[9] === 'string' ? f[9].replace('%', '') : null
        ]);
      }
    }
    const key = Object.hasOwn(PERIOD, mode) ? (adjusted ? 'qfq' : '') + period : period;
    return { code: 0, data: { [symbol]: { [key]: rows, qt: { [symbol]: qt } } } };
  }
  private validate(payload: any, symbol: string, mode: Mode, allowEmpty: boolean) {
    const d = payload?.code === 0 && payload.data?.[symbol],
      p = PERIOD[mode] || mode;
    const rows = rowsOf(d, p);
    if (!Array.isArray(rows) || rows.length > 640 || (!allowEmpty && !rows.length)) throw badData('K线为空或格式无效');
    let previous = '';
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) throw badData('K线字段缺失');
      const time = String(row[0]);
      if (Object.hasOwn(PERIOD, mode)) normalizeDate(time.replaceAll('-', ''));
      else {
        if (!/^\d{12}$/.test(time)) throw badData('分钟时间无效');
        try {
          normalizeDate(time.slice(0, 8));
          timeToMinute(time.slice(8));
        } catch {
          throw badData('分钟时间无效');
        }
      }
      const [open, close, high, low, volume] = row.slice(1, 6).map(number);
      if (
        time <= previous ||
        volume < 0 ||
        (!Array.isArray(d['qfq' + p]) && low <= 0) ||
        low > Math.min(open, close) ||
        high < Math.max(open, close)
      )
        throw badData('K线价格/顺序异常');
      previous = time;
    }
  }
  private save() {
    if (!this.storage) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 200);
  }
  private async persist() {
    if (!this.storage) return;
    const rows = [...this.cache]
      .filter(([key]) => !key.split('|')[2])
      .slice(-40)
      .map(([key, value]) => ({ key, value }));
    await Promise.all([
      this.storage.update(STORAGE, rows),
      this.storage.update('sharedKlineCooldownV1', Object.fromEntries(this.failures))
    ]).catch(() => {});
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.saveTimer);
    for (const f of this.flights.values()) f.controller.abort();
    for (const job of this.queue) job.reject(cancelled());
    this.queue = [];
    void this.persist();
  }
}
const shared = new WeakMap<typeof requestJson, KlineFeed>();
export function getKlineFeed(request = requestJson) {
  let feed = shared.get(request);
  if (!feed || feed.disposed) {
    feed = new KlineFeed(request);
    shared.set(request, feed);
  }
  return feed;
}
