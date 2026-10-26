'use strict';
const { requestJson } = require('./http');
const SOURCES = { eastmoney: '东方财富', xuangubao: '选股宝' };
function plain(value) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, 20000) : '';
}
function parseNews(payload, source) {
  let rows;
  if (source === 'eastmoney') {
    if (String(payload?.code) !== '1' || !Array.isArray(payload?.data?.fastNewsList)) throw new Error('东方财富快讯接口返回异常');
    rows = payload.data.fastNewsList;
  } else if (source === 'xuangubao') {
    if (payload?.code !== 20000 || !Array.isArray(payload?.data?.messages)) throw new Error('选股宝接口未授权或 Token 已过期，请重新设置 Token');
    rows = payload.data.messages;
  } else throw new Error('未知新闻来源');
  const articles = [];
  for (const row of rows) {
    const id = String(source === 'eastmoney' ? row.code ?? '' : row.id ?? '');
    const title = plain(row.title) || plain(row.summary).slice(0, 150);
    const publishedAt = source === 'eastmoney'
      ? /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.showTime || '') ? Date.parse(row.showTime.replace(' ', 'T') + '+08:00') : NaN
      : typeof row.created_at === 'number' && row.created_at > 0 ? row.created_at * 1000 : NaN;
    if (!/^[\w-]{1,100}$/.test(id) || !title || !Number.isFinite(publishedAt)) continue;
    articles.push({ key: `${source}:${id}`, id, source, title,
      body: plain(row.summary) || title, publishedAt,
      stocks: Array.isArray(row.stocks) ? row.stocks.map(s => plain(s.name)).filter(Boolean).join('、') : '' });
  }
  return mergeNews([], articles).items;
}
function isArticle(item) {
  return item && SOURCES[item.source] && /^[\w-]{1,100}$/.test(item.id)
    && item.key === `${item.source}:${item.id}` && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 20000
    && typeof item.body === 'string' && item.body.length <= 20000 && typeof item.stocks === 'string'
    && Number.isFinite(item.publishedAt) && item.publishedAt > 0 && item.publishedAt < 8640000000000000;
}
function mergeNews(existing, incoming, limit = 200) {
  const map = new Map(existing.filter(isArticle).map(item => [item.key, item]));
  const added = [];
  for (const item of incoming) {
    if (!isArticle(item)) continue;
    if (!map.has(item.key)) added.push(item);
    map.set(item.key, item);
  }
  return { items: [...map.values()].sort((a, b) => b.publishedAt - a.publishedAt || b.key.localeCompare(a.key)).slice(0, limit), added };
}
class NewsProvider {
  constructor(request = requestJson) { this.request = request; }
  async load(source, token, signal) {
    let url, headers;
    if (source === 'xuangubao') {
      if (!token) throw new Error('选股宝需要登录 Token，请运行“A股财经新闻：设置选股宝 Token”');
      url = 'https://baoer-api.xuangubao.com.cn/api/v6/message/newsflash?limit=50&subj_ids=9,10,723,35,469,821&has_explain=false&platform=pcweb';
      headers = { 'x-ivanka-token': token, Referer: 'https://xuangutong.com.cn/' };
    } else {
      url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=50&req_trace=1';
      headers = { Referer: 'https://finance.eastmoney.com/' };
    }
    const payload = await this.request(url, signal, headers);
    if (signal?.aborted) throw new Error('新闻请求已取消');
    return parseNews(payload, source);
  }
}
module.exports = { SOURCES, plain, parseNews, isArticle, mergeNews, NewsProvider };
