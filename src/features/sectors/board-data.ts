import { requestJson } from '../../core/network/http';
import { CATEGORIES } from './data';

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
export interface BoardQuery { view: 'table' | 'heatmap'; page: number; sort: 'percent' | 'amount' | 'volume'; direction: 'gainers' | 'losers'; search: string; mapSort?: 'amount' | 'gainers' | 'losers' }
const fields = 'f3,f5,f6,f8,f12,f14,f20,f104,f105,f124,f128,f136';
export class SectorBoardProvider {
  private cooldown = new Map<string, number>();
  constructor(
    private request = requestJson,
    private now = () => Date.now()
  ) {}
  async load(
    category: string,
    signal: AbortSignal,
    query: BoardQuery
  ): Promise<BoardSnapshot> {
    if (!Object.hasOwn(CATEGORIES, category)) throw new Error('板块类型无效');
    if (!query || !['table', 'heatmap'].includes(query.view) || !['percent', 'amount', 'volume'].includes(query.sort) || !['gainers', 'losers'].includes(query.direction) || (query.mapSort !== undefined && !['amount', 'gainers', 'losers'].includes(query.mapSort)) || !Number.isInteger(query.page) || query.page < 1 || query.page > 100 || typeof query.search !== 'string' || query.search.length > 40) throw new Error('板块查询参数无效');
    const hosts = ['push2.eastmoney.com', '82.push2.eastmoney.com', 'push2his.eastmoney.com'];
    const read = async (path: string) => {
      let last: unknown;
      for (const host of hosts) {
        if ((this.cooldown.get(host) || 0) > this.now()) continue;
        try {
          const data = await this.request(`https://${host}${path}`, signal, {
              Referer: 'https://quote.eastmoney.com/'
            });
          this.cooldown.delete(host);
          return parseBoardPage(data, category, this.now());
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
      const suggestions = await this.request(`https://searchapi.eastmoney.com/api/suggest/get?${params}`, signal, { Referer: 'https://quote.eastmoney.com/' });
      const table = suggestions?.QuotationCodeTable;
      if (table?.Status !== 0 || (table.Data != null && !Array.isArray(table.Data))) throw new Error('板块搜索暂不可用');
      const codes = [...new Set<string>((table.Data || []).filter((r: any) => r.Classify === 'BK' && /^BK\d{4,8}$/.test(r.Code || '')).map((r: any) => r.Code))].slice(0, 30);
      if (!codes.length) return { category, rows: [], total: 0, fetchedAt: this.now(), source: '东方财富' };
      const data = await read(`/api/qt/ulist.np/get?${new URLSearchParams({ secids: codes.map((c) => `90.${c}`).join(','), fields, fltt: '2' })}`);
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
    if (result.total && !result.rawCount && (isMap || query.page <= Math.ceil(result.total / 30))) throw new Error('板块列表为空');
    return { category, rows: result.rows, total: result.total, fetchedAt: this.now(), source: '东方财富' };
  }
}
