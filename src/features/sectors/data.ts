import { requestJson, requestBuffer } from '../../core/network/http';

interface SectorQuote {
  code: string;
  name: string;
  percent: number;
  timestamp: number;
  source?: string;
}
const CATEGORIES = {
  industry: { name: '行业', fs: 'm:90+t:2+f:!50' },
  concept: { name: '概念', fs: 'm:90+t:3+f:!50' }
};
const DIRECTIONS = {
  gainers: { name: '涨幅前十', label: '领涨', po: '1', icon: 'arrow-up' },
  losers: { name: '跌幅前十', label: '领跌', po: '0', icon: 'arrow-down' }
};
const compare = (direction) =>
  direction === 'losers' ? (a, b) => a.percent - b.percent : (a, b) => b.percent - a.percent;
const cacheKey = (category, direction) => (direction === 'gainers' ? category : `${category}:${direction}`);
const CONCEPT_POLL_MS = 60000;
const SINA_URLS = {
  concept: 'https://stocks.sina.cn/sh/fieldranking?type=class&vt=4',
  industry: 'https://stocks.sina.cn/sh/fieldranking?type=sina&vt=4'
};
function parseSinaAll(html, category, now = Date.now()) {
  const prefix = category === 'concept' ? 'gn_' : category === 'industry' ? 'new_' : null;
  if (!prefix) throw new Error('未知板块类型');
  const section = typeof html === 'string' && html.match(/<section\s+class="finlist_mod"[^>]*>([\s\S]*?)<\/section>/i);
  if (!section) throw new Error('新浪概念榜页面格式无效');
  const items = [...section[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
  if (items.length < 10) throw new Error('新浪概念榜不足十项');
  const seen = new Set(),
    rows: SectorQuote[] = [];
  for (const item of items) {
    const match = item[1].match(
      /<a\b[^>]*\bboardid=((?:gn_|new_)[a-z0-9_]+)[^>]*>([^<>&]{1,40})<\/a>[\s\S]*?<span\b[^>]*>\s*([+-]?\d+(?:\.\d+)?)%\s*<\/span>/i
    );
    if (
      !match ||
      !match[1].toLowerCase().startsWith(prefix) ||
      seen.has(match[1]) ||
      !Number.isFinite(Number(match[3])) ||
      /[\x00-\x1f]/.test(match[2])
    )
      throw new Error('新浪板块榜字段无效');
    seen.add(match[1]);
    rows.push({
      code: match[1],
      name: match[2].trim(),
      percent: Number(match[3]),
      timestamp: Math.floor(now / 1000),
      source: 'sina'
    });
  }
  if (rows.some((r, i) => !r.name || (i && r.percent > rows[i - 1].percent))) throw new Error('新浪概念榜顺序无效');
  return rows;
}
function selectSina(rows, direction) {
  return direction === 'losers' ? rows.slice(-10).reverse() : rows.slice(0, 10);
}
function parseSina(html, category, now = Date.now(), direction = 'gainers') {
  return selectSina(parseSinaAll(html, category, now), direction);
}
function parseSinaConcept(html, now = Date.now()) {
  return parseSina(html, 'concept', now);
}
function restoreSina(rows, category, now, direction = 'gainers') {
  if (!Array.isArray(rows) || rows.length !== 10) throw new Error('新浪概念榜缓存无效');
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    const validCode = category === 'concept' ? /^gn_[a-z0-9_]+$/i : /^new_[a-z0-9_]+$/i;
    if (
      r.source !== 'sina' ||
      !validCode.test(r.code || '') ||
      seen.has(r.code) ||
      typeof r.name !== 'string' ||
      !r.name.trim() ||
      r.name.length > 40 ||
      /[\x00-\x1f]/.test(r.name) ||
      !Number.isFinite(r.percent) ||
      !Number.isInteger(r.timestamp) ||
      r.timestamp < 946684800 ||
      r.timestamp * 1000 > now + 300000 ||
      (i && compare(direction)(rows[i - 1], r) > 0)
    )
      throw new Error('新浪板块榜缓存无效');
    seen.add(r.code);
  }
  return rows;
}
function parseSectors(payload, category, now = Date.now(), direction = 'gainers') {
  if (
    !Object.hasOwn(CATEGORIES, category) ||
    !Object.hasOwn(DIRECTIONS, direction) ||
    payload?.rc !== 0 ||
    !payload.data?.diff
  )
    throw new Error('板块行情返回无效');
  const rows = Object.values<Record<string, any>>(payload.data.diff),
    seen = new Set(),
    result: SectorQuote[] = [];
  for (const row of rows) {
    const percent =
      typeof row.f3 === 'number'
        ? row.f3
        : typeof row.f3 === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(row.f3)
          ? Number(row.f3)
          : NaN;
    if (
      !/^BK\d{4,8}$/.test(row.f12 || '') ||
      typeof row.f14 !== 'string' ||
      !row.f14.trim() ||
      row.f14.length > 40 ||
      /[\x00-\x1f]/.test(row.f14) ||
      !Number.isFinite(percent) ||
      !Number.isInteger(row.f124) ||
      row.f124 < 946684800 ||
      row.f124 * 1000 > now + 300000 ||
      seen.has(row.f12)
    )
      continue;
    seen.add(row.f12);
    result.push({ code: row.f12, name: row.f14.trim(), percent, timestamp: row.f124 });
  }
  if (result.length !== 10) throw new Error('板块排名不足十项或行情字段无效');
  result.sort(compare(direction));
  return result;
}
class SectorProvider {
  declare request: typeof requestJson;
  declare requestPage: (url: any, signal: any) => Promise<any>;
  declare cooldowns: Map<any, any>;
  declare sinaCache: Map<any, any>;

  constructor(
    request = requestJson,
    requestPage = async (url, signal) => (await requestBuffer(url, signal)).toString('utf8')
  ) {
    this.request = request;
    this.requestPage = requestPage;
    this.cooldowns = new Map();
    this.sinaCache = new Map();
  }
  resetCooldowns() {
    this.cooldowns.clear();
    this.sinaCache.clear();
  }
  async load(category, signal, now = Date.now(), direction = 'gainers') {
    if (!Object.hasOwn(CATEGORIES, category)) throw new Error('未知板块类型');
    const entry = CATEGORIES[category];
    if (!Object.hasOwn(DIRECTIONS, direction)) throw new Error('未知排行方向');
    const params = new URLSearchParams({
      pn: '1',
      pz: '10',
      po: DIRECTIONS[direction].po,
      fid: 'f3',
      fs: entry.fs,
      fields: 'f12,f14,f3,f124',
      fltt: '2'
    });
    let lastError;
    // push2his also serves the ranking with the original f124 quote timestamp.
    // It is still an Eastmoney node, so the independent Sina fallback remains last.
    const hosts = ['push2.eastmoney.com', '82.push2.eastmoney.com', 'push2his.eastmoney.com'];
    const available = hosts.filter((host) => (this.cooldowns.get(host) || 0) <= now);
    for (const host of available) {
      if (signal?.aborted) throw new Error('请求已取消');
      try {
        const rows = parseSectors(
          await this.request(`https://${host}/api/qt/clist/get?${params}`, signal, {
            Referer: 'https://quote.eastmoney.com/'
          }),
          category,
          now,
          direction
        );
        this.cooldowns.delete(host);
        return rows;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        this.cooldowns.set(host, now + 30000);
      }
    }
    if (SINA_URLS[category]) {
      if (signal?.aborted) throw new Error('请求已取消');
      try {
        const cached = this.sinaCache.get(category);
        if (cached && now >= cached.time && now - cached.time < 60000) return selectSina(cached.rows, direction);
        const rows = parseSinaAll(await this.requestPage(SINA_URLS[category], signal), category, now);
        this.sinaCache.set(category, { time: now, rows });
        return selectSina(rows, direction);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = new Error(`东方财富和新浪备用源均不可用：${error.message}`);
      }
    }
    throw lastError || new Error('板块行情接口暂不可用');
  }
}
export {
  SectorQuote,
  CATEGORIES,
  DIRECTIONS,
  compare,
  cacheKey,
  CONCEPT_POLL_MS,
  SINA_URLS,
  parseSinaAll,
  selectSina,
  parseSina,
  parseSinaConcept,
  restoreSina,
  parseSectors,
  SectorProvider
};
