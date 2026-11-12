import { requestJson } from '../../core/network/http';
import { CATEGORIES } from './data';
import { withSectorDeadline } from './request';
import { SinaBoardProvider } from './sina-board';
import { selectSectorHeatmapRows, type SectorHeatmapMode } from '../../shared/sector-heatmap';

export interface BoardRow {
  code: string;
  name: string;
  percent: number;
  volume: number | null;
  amount: number | null;
  turnover: number | null;
  marketCap: number | null;
  up: number | null;
  down: number | null;
  leader: string;
  leaderPercent: number | null;
  timestamp: number | null;
}
export interface BoardSnapshot {
  category: string;
  rows: BoardRow[];
  total: number;
  fetchedAt: number;
  source: string;
  sourceId?: 'eastmoney' | 'sina';
  notice?: string;
  stale?: boolean;
}
const val = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonnegative = (v: unknown) => {
  const n = val(v);
  return n !== null && n >= 0 ? n : null;
};

/** 不用获取时间冒充行情时间；缺失字段保留为空。 */
export function parseBoardPage(payload: any, category: string, now = Date.now()) {
  if (
    !Object.hasOwn(CATEGORIES, category) ||
    payload?.rc !== 0 ||
    !payload.data ||
    !Number.isInteger(payload.data.total)
  )
    throw new Error('板块数据格式异常');
  const total = payload.data.total;
  if (total < 0 || total > 2000 || (total > 0 && (!payload.data.diff || typeof payload.data.diff !== 'object')))
    throw new Error('板块总数无效');
  const rows: BoardRow[] = [];
  for (const r of Object.values<any>(payload.data.diff || {})) {
    if (
      !/^BK\d{4,8}$/.test(r.f12 || '') ||
      typeof r.f14 !== 'string' ||
      !r.f14.trim() ||
      r.f14.length > 40 ||
      /[\x00-\x1f]/.test(r.f14) ||
      val(r.f3) === null
    )
      continue;
    const stamp = nonnegative(r.f124);
    rows.push({
      code: r.f12,
      name: r.f14.trim(),
      percent: r.f3,
      volume: nonnegative(r.f5),
      amount: nonnegative(r.f6),
      turnover: nonnegative(r.f8),
      marketCap: nonnegative(r.f20),
      up: nonnegative(r.f104),
      down: nonnegative(r.f105),
      leader: typeof r.f128 === 'string' && r.f128.length <= 40 ? r.f128 : '',
      leaderPercent: val(r.f136),
      timestamp: stamp && stamp >= 946684800 && stamp * 1000 <= now + 300000 ? stamp : null
    });
  }
  return { total, rows, rawCount: Object.values(payload.data.diff || {}).length };
}
export interface BoardQuery { view: 'table' | 'heatmap'; page: number; sort: 'percent' | 'amount' | 'volume'; direction: 'gainers' | 'losers'; search: string; mapSort?: SectorHeatmapMode }
const fields = 'f3,f5,f6,f8,f12,f14,f20,f104,f105,f124,f128,f136';
export class SectorBoardProvider {
  private cooldown = new Map<string, number>();
  private preferredHost = '';
  private primaryRetryAt = 0;
  private primaryTimeoutMs = 8000;
  constructor(
    private request = requestJson,
    private now = () => Date.now(),
    private requestTimeoutMs = 3500,
    private backup = new SinaBoardProvider(undefined, now, requestTimeoutMs)
  ) {}
  attach(storage: Parameters<SinaBoardProvider['attach']>[0]) {
    this.backup.attach?.(storage);
  }
  private read(url: string, signal: AbortSignal) {
    return withSectorDeadline(
      signal,
      this.requestTimeoutMs,
      (requestSignal) => this.request(url, requestSignal, { Referer: 'https://quote.eastmoney.com/' }),
      '板块数据源响应超时'
    );
  }
  async load(
    category: string,
    signal: AbortSignal,
    query: BoardQuery
  ): Promise<BoardSnapshot> {
    if (!Object.hasOwn(CATEGORIES, category)) throw new Error('板块类型无效');
    if (!query || !['table', 'heatmap'].includes(query.view) || !['percent', 'amount', 'volume'].includes(query.sort) || !['gainers', 'losers'].includes(query.direction) || (query.mapSort !== undefined && !['amount', 'gainers', 'losers'].includes(query.mapSort)) || !Number.isInteger(query.page) || query.page < 1 || query.page > 100 || typeof query.search !== 'string' || query.search.length > 40) throw new Error('板块查询参数无效');
    if (signal.aborted) throw new Error('请求已取消');
    let primaryError: unknown = new Error('东方财富来源冷却中');
    if (this.primaryRetryAt <= this.now()) {
      try {
        const data = await withSectorDeadline(
          signal, this.primaryTimeoutMs,
          (requestSignal) => this.loadEastmoney(category, requestSignal, query),
          '东方财富板块请求超时'
        );
        this.primaryRetryAt = 0;
        return data;
      } catch (error) {
        if (signal.aborted) throw error;
        primaryError = error;
        this.primaryRetryAt = this.now() + 60000;
      }
    }
    try {
      return await this.backup.load(category, signal, query);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`东方财富和新浪板块均不可用：${primaryError instanceof Error ? primaryError.message : '主源获取失败'}；${error.message}`);
    }
  }
  private async loadEastmoney(category: string, signal: AbortSignal, query: BoardQuery): Promise<BoardSnapshot> {
    const hosts = ['push2.eastmoney.com', '82.push2.eastmoney.com', 'push2his.eastmoney.com'];
    if (this.preferredHost) hosts.sort((left, right) => Number(right === this.preferredHost) - Number(left === this.preferredHost));
    const read = async (path: string) => {
      let last: unknown;
      for (const host of hosts) {
        if ((this.cooldown.get(host) || 0) > this.now()) continue;
        try {
          const data = await this.read(`https://${host}${path}`, signal);
          const result = parseBoardPage(data, category, this.now());
          this.cooldown.delete(host);
          this.preferredHost = host;
          return result;
        } catch (e) {
          if (signal.aborted) throw e;
          last = e;
          this.cooldown.set(host, this.now() + 60000);
        }
      }
      throw new Error(`板块数据暂不可用：${last instanceof Error ? last.message : '来源冷却中'}`);
    };
    if (signal.aborted) throw new Error('请求已取消');
    if (query.view === 'table' && query.search.trim()) {
      const params = new URLSearchParams({ input: query.search.trim(), type: '14', count: '100' });
      const suggestions = await this.read(`https://searchapi.eastmoney.com/api/suggest/get?${params}`, signal);
      const table = suggestions?.QuotationCodeTable;
      if (table?.Status !== 0 || (table.Data != null && !Array.isArray(table.Data))) throw new Error('板块搜索暂不可用');
      const codes = [...new Set<string>((table.Data || []).filter((r: any) => r.Classify === 'BK' && /^BK\d{4,8}$/.test(r.Code || '')).map((r: any) => r.Code))].slice(0, 30);
      if (!codes.length) return { category, rows: [], total: 0, fetchedAt: this.now(), source: '东方财富' };
      const data = await read(`/api/qt/ulist.np/get?${new URLSearchParams({ secids: codes.map((c) => `90.${c}`).join(','), fields, fltt: '2' })}`);
      if (!data.rows.length) throw new Error('板块搜索未返回有效行情');
      const rows = data.rows.sort((a, b) => {
        const key = query.sort, av = a[key], bv = b[key];
        if (av === null) return bv === null ? 0 : 1;
        if (bv === null) return -1;
        return (key === 'percent' && query.direction === 'losers' ? 1 : -1) * (av - bv);
      });
      return { category, rows, total: rows.length, fetchedAt: this.now(), source: '东方财富' };
    }
    const isMap = query.view === 'heatmap';
    const orderBy = isMap ? (query.mapSort === 'gainers' || query.mapSort === 'losers' ? 'percent' : 'amount') : query.sort;
    const orderDirection = isMap && query.mapSort === 'losers' ? 'losers' : isMap ? 'gainers' : query.direction;
    const params = new URLSearchParams({ pn: String(isMap ? 1 : query.page), pz: isMap ? '50' : '30', po: orderBy !== 'percent' || orderDirection === 'gainers' ? '1' : '0', fid: ({ percent: 'f3', amount: 'f6', volume: 'f5' })[orderBy], fs: CATEGORIES[category].fs, fields, fltt: '2' });
    const result = await read(`/api/qt/clist/get?${params}`);
    if (!result.total) throw new Error('板块列表暂未返回数据');
    if (result.total && !result.rows.length && (isMap || query.page <= Math.ceil(result.total / 30))) throw new Error('板块列表为空');
    const rows = isMap ? selectSectorHeatmapRows(result.rows, query.mapSort || 'amount') : result.rows;
    return { category, rows, total: result.total, fetchedAt: this.now(), source: '东方财富' };
  }
}
