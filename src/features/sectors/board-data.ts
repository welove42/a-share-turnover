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
  if (total < 1 || total > 2000 || !payload.data.diff || typeof payload.data.diff !== 'object')
    throw new Error('板块总数无效');
  const rows: BoardRow[] = [];
  for (const r of Object.values<any>(payload.data.diff)) {
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
  return { total, rows, rawCount: Object.values(payload.data.diff).length };
}
function pause(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('请求已取消'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error('请求已取消'));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export class SectorBoardProvider {
  private cooldown = new Map<string, number>();
  constructor(
    private request = requestJson,
    private now = () => Date.now(),
    private gap = 750
  ) {}
  async load(
    category: string,
    signal: AbortSignal,
    progress: (done: number, total: number) => void = () => {}
  ): Promise<BoardSnapshot> {
    if (!Object.hasOwn(CATEGORIES, category)) throw new Error('板块类型无效');
    const rows: BoardRow[] = [];
    const seen = new Set<string>();
    let total = Infinity;
    const hosts = ['push2.eastmoney.com', '82.push2.eastmoney.com', 'push2his.eastmoney.com'];
    for (let page = 1; page <= Math.ceil(total / 100) && page <= 20; page++) {
      if (signal.aborted) throw new Error('请求已取消');
      if (page > 1) await pause(signal, this.gap);
      const params = new URLSearchParams({
        pn: String(page),
        pz: '100',
        po: '1',
        fid: 'f12',
        fs: CATEGORIES[category].fs,
        fields: 'f3,f5,f6,f8,f12,f14,f20,f104,f105,f124,f128,f136',
        fltt: '2'
      });
      let data: ReturnType<typeof parseBoardPage> | undefined, last: unknown;
      for (const host of hosts) {
        if ((this.cooldown.get(host) || 0) > this.now()) continue;
        try {
          data = parseBoardPage(
            await this.request(`https://${host}/api/qt/clist/get?${params}`, signal, {
              Referer: 'https://quote.eastmoney.com/'
            }),
            category,
            this.now()
          );
          this.cooldown.delete(host);
          break;
        } catch (e) {
          if (signal.aborted) throw e;
          last = e;
          this.cooldown.set(host, this.now() + 60000);
        }
      }
      if (!data) throw new Error(`板块数据暂不可用：${last instanceof Error ? last.message : '来源冷却中'}`);
      if (page === 1) total = data.total;
      if (!data.rawCount) throw new Error('板块列表不完整，请稍后重试');
      for (const row of data.rows)
        if (!seen.has(row.code)) {
          seen.add(row.code);
          rows.push(row);
        }
      progress(rows.length, total);
      // 无效或重复记录不应无限翻页或冒充完整列表。
      if (data.rawCount < 100 && page < Math.ceil(total / 100)) throw new Error('板块列表不完整，请稍后重试');
    }
    if (!rows.length) throw new Error('没有有效板块行情');
    return { category, rows, total, fetchedAt: this.now(), source: '东方财富' };
  }
}
