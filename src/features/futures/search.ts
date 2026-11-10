import type { CommodityEntry } from '../../shared/types';
import { requestBuffer } from '../../core/network/http';
import { COMMODITIES, entryFor, registerCommodity } from '../commodities/data';

// 这些只是离线候选，完整品种与在市月份合约由新浪搜索接口返回。
const POPULAR: CommodityEntry[] = [
  ...COMMODITIES.filter((entry) => !['XAU', 'XAG'].includes(entry.code)),
  ...[
    ['RB0', '螺纹钢主连', '元/吨', '螺纹钢 RB lwg'],
    ['AU0', '沪金主连', '元/克', '黄金 上海黄金 AU hj'],
    ['AG0', '沪银主连', '元/千克', '白银 上海白银 AG by'],
    ['CU0', '沪铜主连', '元/吨', '铜 CU ht'],
    ['SI0', '工业硅主连', '元/吨', '工业硅 SI gyg'],
    ['SC0', '原油主连', '元/桶', '上海原油 SC yy'],
    ['IF0', '沪深300期货主连', '点', '股指期货 IF hs300'],
    ['T0', '10年期国债期货主连', '元/百元面值', '国债 T gz']
  ].map(
    ([code, name, unit, aliases]): CommodityEntry => ({
      code,
      name,
      unit,
      aliases,
      market: 'domesticFutures',
      ...(/^(IF|T)0$/.test(code) ? { quoteSchema: 'financial' as const } : {})
    })
  ),
  ...[
    ['ES', '标普500期货', '标普 ES SP500 bp'],
    ['YM', '道琼斯期货', '道指 YM Dow dj'],
    ['NK', '日经225期货', '日经 NK Nikkei rj'],
    ['HSI', '恒生指数期货', '恒指 HSI hs']
  ].map(([code, name, aliases]): CommodityEntry => ({ code, name, aliases, unit: '点', market: 'cfd' }))
];
const CATALOG_KEY = 'futuresCatalogV1';
const FINANCIAL = /^(IF|IH|IC|IM|T|TF|TS|TL)(?:0|\d{3,4})$/;

function initializeFuturesCatalog(saved: unknown = []): void {
  for (const entry of POPULAR) registerCommodity(entry);
  if (Array.isArray(saved))
    for (const entry of saved.slice(0, 4000)) {
      try {
        registerCommodity(entry);
      } catch {
        /* 忽略损坏的缓存，仍保留内置候选。 */
      }
    }
}
function futuresKind(entry: CommodityEntry): string {
  return entry.market === 'domesticFutures'
    ? `${entry.quoteSchema === 'financial' ? '国内金融期货' : '国内商品期货'} · ${/^[A-Z]+0$/.test(entry.code) ? '主连' : '月份合约'}`
    : `海外期货 · CFD参考${/\d{4}$/.test(entry.code) ? ' · 月份合约' : ''}`;
}
function searchQuery(input: string): { key: string; prefix?: string } {
  const trimmed = input.trim();
  if (trimmed.length > 60 || /[\x00-\x1f]/.test(trimmed)) throw new Error('请输入60字以内的期货名称或代码');
  const match = /^(hf|nf)_(.*)$/i.exec(trimmed);
  return { key: match ? match[2] : trimmed, prefix: match?.[1].toLowerCase() };
}
function rankEntries(entries: CommodityEntry[], input: string, filter: boolean): CommodityEntry[] {
  const { key, prefix } = searchQuery(input),
    query = key.toUpperCase();
  const unique = new Map<string, CommodityEntry>();
  for (const entry of entries) {
    if (prefix && prefix !== (entry.market === 'domesticFutures' ? 'nf' : 'hf')) continue;
    if (filter && query && !`${entry.code} ${entry.name} ${entry.aliases}`.toUpperCase().includes(query)) continue;
    unique.set(entry.code, entry);
  }
  const score = (entry: CommodityEntry) =>
    entry.code === query
      ? 0
      : entry.code === query + '0'
        ? 1
        : entry.name === key
          ? 2
          : entry.name.includes(key)
            ? 3
            : 4;
  return [...unique.values()].sort((a, b) => score(a) - score(b)).slice(0, 80);
}

/** 只读新浪建议中的期货类型，过滤股票、基金、期权、EFP及任意脚本。 */
function parseFuturesSuggestions(text: string): CommodityEntry[] {
  const match = /^\s*var\s+futures_hint\s*=\s*"([^"\r\n]*)"\s*;?\s*$/.exec(text);
  if (!match) throw new Error('期货搜索响应格式异常');
  const entries = new Map<string, CommodityEntry>();
  for (const row of match[1].split(';')) {
    const fields = row.split(','),
      type = fields[1],
      code = fields[2]?.toUpperCase(),
      name = fields[4]?.trim();
    if (!['85', '86', '87', '88'].includes(type) || !name || name.length > 100 || /[<>\\\x00-\x1f]/.test(name))
      continue;
    const domestic = type !== '86';
    if (!(domestic ? /^[A-Z]{1,3}(?:0|\d{3,4})$/ : /^[A-Z]{1,8}(?:\d{4})?$/).test(code || '')) continue;
    const market = domestic ? 'domesticFutures' : 'cfd';
    const root = code.replace(/\d+$/, '');
    const known = entryFor(code),
      base = entryFor(domestic ? root + '0' : root);
    if (known && known.market !== market) continue;
    const financial = domestic && (type === '88' || FINANCIAL.test(code));
    const unit = base?.market === market ? base.unit : financial ? (/^I/.test(code) ? '点' : '元/百元面值') : '';
    entries.set(
      code,
      known || {
        code,
        name: domestic && /^[A-Z]+0$/.test(code) ? name.replace(/连续/g, '主连') : name,
        market,
        unit,
        aliases: `${name} ${fields[0] || ''}`.slice(0, 240),
        ...(financial ? { quoteSchema: 'financial' as const } : {})
      }
    );
  }
  return [...entries.values()];
}

class FuturesSearch {
  private cache = new Map<string, { at: number; entries: CommodityEntry[] }>();
  constructor(
    private request = requestBuffer,
    private now = Date.now
  ) {
    initializeFuturesCatalog();
  }

  local(input: string, selected: string[] = []): CommodityEntry[] {
    return rankEntries(
      [
        ...POPULAR,
        ...[...this.cache.values()].flatMap((value) => value.entries),
        ...selected.map(entryFor).filter((entry): entry is CommodityEntry => Boolean(entry))
      ],
      input,
      true
    );
  }
  async search(input: string, signal?: AbortSignal): Promise<CommodityEntry[]> {
    const { key, prefix } = searchQuery(input);
    if (!key) return this.local(input);
    if (signal?.aborted) throw new Error('搜索已取消');
    const cacheKey = key.toUpperCase(),
      cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.at < 300000) return rankEntries(cached.entries, input, false);
    const buffer = await this.request(
      `https://suggest3.sinajs.cn/suggest/type=85,86,87,88&key=${encodeURIComponent(key)}&name=futures_hint`,
      signal,
      { Referer: 'https://finance.sina.com.cn/' }
    );
    if (signal?.aborted) throw new Error('搜索已取消');
    const entries = parseFuturesSuggestions(new TextDecoder('gb18030').decode(buffer));
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, { at: this.now(), entries });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return rankEntries(entries, prefix ? `${prefix}_${key}` : key, false);
  }
}
export { CATALOG_KEY, initializeFuturesCatalog, futuresKind, parseFuturesSuggestions, FuturesSearch };
