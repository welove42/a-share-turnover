'use strict';
const { requestJson } = require('./http');
const { supportsTurnover } = require('./quotes');
const { attempt, abortError } = require('./ai-data');
const MAX_BOARDS = 80;
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
const boardName = value => typeof value === 'string' && value.trim() && value.length <= 80 && !/[\x00-\x1f]/.test(value) ? value.trim() : null;
function parseBoardQuotes(payload, now) {
  if (payload?.rc !== 0 || !payload.data?.diff) throw new Error('所属板块行情不可用');
  const rows = [], seen = new Set();
  for (const row of Object.values(payload.data.diff)) {
    if (!/^BK\d{4,8}$/.test(row.f12 || '') || !boardName(row.f14) || seen.has(row.f12)) continue;
    seen.add(row.f12);
    const timestamp = numeric(row.f124), validTime = timestamp > 946684800 && timestamp * 1000 <= now + 300000;
    rows.push({ code: row.f12, name: boardName(row.f14), price: numeric(row.f2), percent: numeric(row.f3), amount: numeric(row.f6), turnoverRate: numeric(row.f8), advancing: numeric(row.f104), declining: numeric(row.f105), timestamp: validTime ? timestamp : null });
  }
  if (!rows.length) throw new Error('所属板块为空');
  return { rows: rows.slice(0, MAX_BOARDS), total: Math.max(rows.length, numeric(payload.data.total) || 0) };
}
function parseMembership(payload, symbol) {
  const raw = payload?.ssbk || payload?.result?.data;
  if (!Array.isArray(raw)) throw new Error('所属板块资料不可用');
  const seen = new Set(), rows = [];
  for (const row of [...raw].sort((a, b) => (Number(a.BOARD_RANK) || 999) - (Number(b.BOARD_RANK) || 999))) {
    if (row.SECURITY_CODE !== symbol.slice(2) || !boardName(row.BOARD_NAME)) continue;
    const number = String(row.BOARD_CODE || '').replace(/^BK/, '');
    if (!/^\d{1,8}$/.test(number)) continue;
    const code = 'BK' + number.padStart(4, '0');
    if (seen.has(code)) continue;
    seen.add(code); rows.push({ code, name: boardName(row.BOARD_NAME) });
  }
  if (!rows.length) throw new Error('未查询到此股票的所属板块');
  return { rows: rows.slice(0, MAX_BOARDS), total: rows.length };
}
class AiSectorProvider {
  constructor({ request = requestJson, now = () => Date.now() } = {}) { this.request = request; this.now = now; this.cache = new Map(); }
  async get(url, signal) {
    const result = await attempt(s => this.request(url, s, { Referer: 'https://quote.eastmoney.com/' }), signal, 3000);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  async load(symbol, signal) {
    if (signal?.aborted) throw abortError();
    if (!supportsTurnover(symbol)) return { applicable: false, reason: 'ETF / 指数不套用个股所属行业，未取得跟踪指数或成分时不猜测板块归属。', rows: [] };
    const now = this.now(), old = this.cache.get(symbol);
    if (old && now - old.fetchedAtMs < 60000 && now >= old.fetchedAtMs) return { ...old, cached: true, cacheReason: '复用一分钟内的板块快照' };
    const secid = `${symbol.startsWith('sh') ? 1 : 0}.${symbol.slice(2)}`;
    const fields = 'f12,f14,f2,f3,f6,f8,f104,f105,f124';
    const params = new URLSearchParams({ spt: '3', pi: '0', pz: String(MAX_BOARDS), po: '1', secid, fields, fid: 'f3', fltt: '2' });
    let industry = old?.industry || null;
    const industryTask = attempt(async s => {
      for (const host of ['push2.eastmoney.com', 'push2his.eastmoney.com']) {
        try { const d = (await this.get(`https://${host}/api/qt/stock/get?secid=${secid}&fields=f57,f127`, s))?.data; if (d?.f57 === symbol.slice(2) && boardName(d.f127)) return boardName(d.f127); }
        catch { if (s.aborted) throw abortError(); }
      }
      return null;
    }, signal, 7000);
    // Observe rejection immediately if the parent is canceled during another source.
    const safeIndustry = industryTask.catch(() => ({ ok: false }));
    let membership, rows, metadataSource = '东方财富所属板块行情', quoteFailure = false;
    try {
      for (const host of ['push2.eastmoney.com', 'push2his.eastmoney.com']) {
        try { membership = parseBoardQuotes(await this.get(`https://${host}/api/qt/slist/get?${params}`, signal), now); rows = membership.rows; break; }
        catch { if (signal?.aborted) throw abortError(); }
      }
      if (!membership) {
        metadataSource = '东方财富核心题材资料';
        try { membership = parseMembership(await this.get(`https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${symbol.toUpperCase()}`, signal), symbol); }
        catch {
          if (signal?.aborted) throw abortError();
          const query = new URLSearchParams({ reportName: 'RPT_F10_CORETHEME_BOARDTYPE', columns: 'SECURITY_CODE,BOARD_CODE,BOARD_NAME,BOARD_RANK', source: 'WEB', client: 'WEB', filter: `(SECURITY_CODE="${symbol.slice(2)}")`, sortColumns: 'BOARD_RANK', sortTypes: '1', pageSize: String(MAX_BOARDS) });
          membership = parseMembership(await this.get(`https://datacenter.eastmoney.com/securities/api/data/v1/get?${query}`, signal), symbol);
        }
        rows = membership.rows;
        try {
          const query = new URLSearchParams({ secids: rows.map(r => '90.' + r.code).join(','), fields, fltt: '2' });
          const q = parseBoardQuotes(await this.get(`https://push2.eastmoney.com/api/qt/ulist.np/get?${query}`, signal), now).rows;
          const map = new Map(q.map(r => [r.code, r])); rows = rows.map(r => map.get(r.code) || r);
        } catch { if (signal?.aborted) throw abortError(); quoteFailure = true; }
      }
      const detail = await safeIndustry;
      if (signal?.aborted) throw abortError();
      if (detail.ok && detail.value) industry = detail.value;
      const result = { applicable: true, industry, industryCached: Boolean(industry && !detail.value), source: metadataSource, fetchedAt: new Date(now).toISOString(), fetchedAtMs: now, cached: false, total: membership.total, truncated: membership.total > rows.length, quoteFailure, rows };
      this.cache.set(symbol, result); if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
      return result;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (old && now - old.fetchedAtMs >= 0 && now - old.fetchedAtMs < 7 * 86400000) return { ...old, cached: true, cacheReason: '板块接口失败，保留原快照和原行情时间' };
      throw error;
    }
  }
}
module.exports = { AiSectorProvider, parseBoardQuotes, parseMembership, MAX_BOARDS };
