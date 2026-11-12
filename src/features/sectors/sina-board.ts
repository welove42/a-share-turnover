import type { Memento } from 'vscode';
import { requestBuffer } from '../../core/network/http';
import type { BoardQuery, BoardRow, BoardSnapshot } from './board-data';
import { withSectorDeadline } from './request';
import { selectSectorHeatmapRows } from '../../shared/sector-heatmap';

const URLS = {
  industry: 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php',
  concept: 'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class'
};
const CACHE_STATE = 'sector-board-sina-cache-v1';
const CACHE_MS = 60000;
const MAX_AGE = 86400000;
const NOTICE = '东方财富暂不可用，已切换新浪板块口径；分类及数量不同，未提供原始行情时间、换手率和涨跌家数。';

function number(value: string): number | null {
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function nonnegative(value: string): number | null {
  const parsed = number(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
function name(value: string): boolean {
  return !!value.trim() && value.length <= 40 && !/[\x00-\x1f\uFFFD]/.test(value);
}

/** 新浪列6为股、列7为元；只解析赋值右侧的 JSON，不执行远端脚本。 */
export function parseSinaBoard(text: string, category: string): BoardRow[] {
  const variable = category === 'industry' ? 'sinaindustry' : category === 'concept' ? 'class' : '';
  if (!variable || typeof text !== 'string' || text.length > 100000) throw new Error('新浪板块数据无效');
  const assignment = text.match(/^\s*var\s+S_Finance_bankuai_(sinaindustry|class)\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!assignment || assignment[1] !== variable) throw new Error('新浪板块类型或格式不匹配');
  const payload: unknown = JSON.parse(assignment[2]);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('新浪板块数据格式异常');
  const entries = Object.entries(payload);
  if (!entries.length || entries.length > 2000) throw new Error('新浪板块数量无效');
  const prefix = category === 'industry' ? /^new_[a-z0-9_]+$/i : /^gn_[a-z0-9_]+$/i;
  const rows: BoardRow[] = [];
  for (const [code, value] of entries) {
    if (!prefix.test(code) || typeof value !== 'string') continue;
    const fields = value.split(',');
    if (fields.length !== 13 || fields[0] !== code || !name(fields[1])) continue;
    const percent = number(fields[5]);
    if (percent === null) continue;
    const shares = nonnegative(fields[6]);
    rows.push({
      code,
      name: fields[1].trim(),
      percent,
      volume: shares === null ? null : shares / 100,
      amount: nonnegative(fields[7]),
      turnover: null,
      marketCap: null,
      up: null,
      down: null,
      leader: name(fields[12]) ? fields[12].trim() : '',
      leaderPercent: number(fields[9]),
      timestamp: null
    });
  }
  if (!rows.length) throw new Error('新浪未返回有效板块');
  return rows;
}

async function requestSina(url: string, signal: AbortSignal): Promise<string> {
  const buffer = await requestBuffer(url, signal, { Referer: 'https://finance.sina.com.cn/' });
  const utf8 = buffer.toString('utf8');
  return utf8.includes('\uFFFD') ? new TextDecoder('gb18030').decode(buffer) : utf8;
}

interface Summary {
  rows: BoardRow[];
  text: string;
  fetchedAt: number;
}

export class SinaBoardProvider {
  private cache = new Map<string, Summary>();
  private failed = new Map<string, number>();
  private storage?: Pick<Memento, 'get' | 'update'>;
  private saving: Promise<unknown> = Promise.resolve();
  constructor(
    private request = requestSina,
    private now = () => Date.now(),
    private requestTimeoutMs = 3500
  ) {}
  attach(storage: Pick<Memento, 'get' | 'update'>) {
    this.storage = storage;
    const saved = storage.get<unknown>(CACHE_STATE, []);
    if (!Array.isArray(saved)) return;
    for (const entry of saved.slice(0, 2)) {
      try {
        if (
          !Object.hasOwn(URLS, entry?.category) ||
          !Number.isFinite(entry.fetchedAt) ||
          entry.fetchedAt > this.now() ||
          this.now() - entry.fetchedAt > MAX_AGE
        )
          continue;
        this.cache.set(entry.category, {
          text: entry.text,
          fetchedAt: entry.fetchedAt,
          rows: parseSinaBoard(entry.text, entry.category)
        });
      } catch {}
    }
  }
  private save() {
    if (!this.storage) return;
    const entries = [...this.cache].map(([category, summary]) => ({
      category,
      text: summary.text,
      fetchedAt: summary.fetchedAt
    }));
    this.saving = this.saving.then(() => this.storage!.update(CACHE_STATE, entries)).catch(() => {});
  }
  async load(category: string, signal: AbortSignal, query: BoardQuery): Promise<BoardSnapshot> {
    if (signal.aborted) throw new Error('请求已取消');
    if (!Object.hasOwn(URLS, category)) throw new Error('新浪板块类型无效');
    let summary = this.cache.get(category);
    let stale = false;
    if (!summary || this.now() < summary.fetchedAt || this.now() - summary.fetchedAt >= CACHE_MS) {
      try {
        if ((this.failed.get(category) || 0) > this.now()) throw new Error('新浪板块来源冷却中');
        const text = await withSectorDeadline(
          signal,
          this.requestTimeoutMs,
          (requestSignal) => this.request(URLS[category as keyof typeof URLS], requestSignal),
          '新浪板块响应超时'
        );
        const rows = parseSinaBoard(text, category);
        summary = { rows, text, fetchedAt: this.now() };
        this.cache.set(category, summary);
        this.failed.delete(category);
        this.save();
      } catch (error) {
        if (signal.aborted) throw error;
        if ((this.failed.get(category) || 0) <= this.now()) this.failed.set(category, this.now() + CACHE_MS);
        if (!summary || this.now() < summary.fetchedAt || this.now() - summary.fetchedAt > MAX_AGE) throw error;
        stale = true;
      }
    }
    const search = query.view === 'table' ? query.search.trim().toLowerCase() : '';
    const rows = summary.rows.filter(
      (row) => !search || row.name.toLowerCase().includes(search) || row.code.toLowerCase().includes(search)
    );
    const sort = query.sort;
    const ascending = sort === 'percent' && query.direction === 'losers';
    rows.sort((left, right) => {
      const first = left[sort],
        second = right[sort];
      if (first === null) return second === null ? left.code.localeCompare(right.code) : 1;
      if (second === null) return -1;
      return (ascending ? 1 : -1) * (first - second) || left.code.localeCompare(right.code);
    });
    const start = (query.page - 1) * 30;
    return {
      category,
      rows: query.view === 'heatmap' ? selectSectorHeatmapRows(rows, query.mapSort || 'amount') : rows.slice(start, start + 30),
      total: rows.length,
      fetchedAt: summary.fetchedAt,
      source: '新浪财经（备用）',
      sourceId: 'sina',
      notice:
        NOTICE +
        (stale ? ' 本次更新失败，显示最近一次新浪快照。' : '') +
        (search ? ' 搜索使用新浪名称或代码，不对应东方财富 BK 编码。' : ''),
      stale
    };
  }
}
