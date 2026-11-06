'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseFundEstimates, isFundEstimate, estimateReason, FundEstimateProvider } = require('../src/fund-estimates');
const row = (code = '110020', extra = {}) => ({ FCODE: code, SHORTNAME: '测试基金', NAV: 1.5, PDATE: '2026-11-05', GSZ: 1.53, GSZZL: 2, GZTIME: '2026-11-06 10:30', ...extra });
const payload = rows => ({ success: true, errorCode: 0, data: rows });
const quote = { code: '110020', kind: 'nav', nav: 1.5, date: '2026-11-05' };
const estimate = extra => parseFundEstimates(payload([row('110020', extra)]), ['110020']).estimates.get('110020');

test('批量估值按代码匹配，空值不当成零；缺失、重复及异常数据分别处理', () => {
  const result = parseFundEstimates(payload([row('510300'), row('110020'), row('005827', { GSZ: null, GSZZL: null, GZTIME: null }), row('000198', { GSZ: 0 })]), ['110020', '005827', '000198', '161725']);
  assert.equal(result.estimates.size, 1); assert.equal(result.estimates.get('110020').nav, 1.53);
  assert.deepEqual([...result.unavailable], ['005827']); assert.equal(result.errors.size, 2);
  assert.equal(estimate({ GSZ: 1.5, GSZZL: 0 }).percent, 0);
  for (const extra of [{ GSZZL: null }, { GSZ: '' }, { GSZ: 'NaN' }, { GSZZL: 99 }, { GZTIME: '2026-02-30 10:30' }, { GZTIME: '2026-11-06 25:00' }, { PDATE: '2026-11-06' }, { SHORTNAME: '<script>' }]) assert.equal(estimate(extra), undefined);
  const duplicates = parseFundEstimates(payload([row(), row()]), ['110020']); assert.equal(duplicates.estimates.size, 0); assert.equal(duplicates.errors.size, 1);
  for (const value of [{ success: false, data: [] }, { success: true, errorCode: 1, data: [] }, '<html/>']) assert.throws(() => parseFundEstimates(value, ['110020']));
  assert.equal(isFundEstimate({ ...estimate(), code: 110020 }), false);
});

test('只使用今日且基准相符的近期估值；正式净值发布、跨日、旧时间、未来数据均回退', () => {
  const e = estimate(), now = new Date('2026-11-06T10:32:00+08:00');
  assert.equal(estimateReason(e, quote, now), '');
  assert.match(estimateReason(e, { ...quote, date: '2026-11-06' }, now), /正式净值已公布/);
  assert.match(estimateReason(e, { ...quote, nav: 1.6 }, now), /基准/);
  assert.match(estimateReason(e, { ...quote, code: '510300' }, now), /核对/);
  assert.match(estimateReason(e, quote, new Date('2026-11-06T10:46:00+08:00')), /15个交易分钟/);
  assert.match(estimateReason(e, quote, new Date('2026-11-07T10:32:00+08:00')), /今日/);
  assert.match(estimateReason(e, quote, new Date('2026-11-06T10:20:00+08:00')), /时间异常/);
  assert.equal(estimateReason(estimate({ GZTIME: '2026-11-06 11:30' }), quote, new Date('2026-11-06T12:55:00+08:00')), '');
  assert.equal(estimateReason(estimate({ GZTIME: '2026-11-06 15:00' }), quote, new Date('2026-11-06T20:00:00+08:00')), '');
  assert.match(estimateReason(e, quote, new Date('2026-11-06T20:00:00+08:00')), /15个交易分钟/);
});

test('估值一次批量请求，主域失败切备用并记住可用域名，不携带持仓；取消后不重试', async () => {
  const urls = [], provider = new FundEstimateProvider({ request: async (url, signal, headers) => {
    const u = new URL(url); urls.push(u); assert.equal(headers.Referer, 'https://h5.1234567.com.cn/');
    assert.equal(u.searchParams.get('FCODES'), '110020,005827'); assert.deepEqual([...u.searchParams.keys()], ['FCODES', 'FIELDS']);
    if (u.host === 'fundcomapi.eastmoney.com') throw new Error('请求失败');
    return payload([row(), row('005827', { GSZ: null, GSZZL: null, GZTIME: null })]);
  } });
  assert.equal((await provider.load(['110020', '005827'])).estimates.size, 1); assert.equal(urls.length, 2);
  await provider.load(['110020', '005827']); assert.equal(urls.length, 3); assert.equal(urls[2].host, 'fundcomapi.tiantianfunds.com');
  const abort = new AbortController(); let calls = 0;
  const cancelled = new FundEstimateProvider({ request: async () => { calls++; abort.abort(); throw new Error('中止'); } });
  await assert.rejects(cancelled.load(['110020'], abort.signal), /取消/); assert.equal(calls, 1);
  await assert.rejects(provider.load(['110020?shares=100']), /代码无效/);
});
