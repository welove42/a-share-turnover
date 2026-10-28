'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { MinuteFeed, WAF_COOLDOWN, FAILURE_COOLDOWN } = require('../src/minute-feed');
const { ChartProvider } = require('../src/chart-data');
const { MarketProvider } = require('../src/provider');
const { SYMBOLS, minutePayload, historyPayload } = require('./fixtures');
const NOW = new Date('2026-10-26T10:30:30+08:00');
const httpError = status => Object.assign(new Error(`数据接口 HTTP ${status}`), { statusCode: status });

test('主分时HTTP 501自动切换腾讯备用，保留原始分钟成交量、成交额及真实均价', async () => {
  const calls = [], signal = new AbortController().signal;
  const provider = new ChartProvider(async (url, received) => {
    calls.push(url); assert.equal(received, signal);
    if (new URL(url).hostname === 'web.ifzq.gtimg.cn') throw httpError(501);
    return minutePayload('sh600105', 340000, '20261026103030', ['0930 10 100 100000', '0931 12 300 340000']);
  });
  const data = await provider.load('600105', 'intraday', signal);
  assert.deepEqual(calls.map(url=>new URL(url).hostname), ['web.ifzq.gtimg.cn', 'ifzq.gtimg.cn']);
  assert.ok(calls.every(url=>new URL(url).pathname === '/appstock/app/minute/query'));
  assert.equal(data.mode, 'intraday'); assert.equal(data.date, '2026-10-26');
  assert.match(data.source, /分时备用/);
  assert.equal(data.bars[1].volume, 200); assert.equal(data.bars[1].amount, 240000);
  assert.equal(data.bars[1].averagePrice, 340000 / 30000);
});

test('501域名冷却五分钟，盘中10秒刷新和快速切股不反复打被拦接口，恢复后回到主源', async () => {
  let now = 0, blocked = true; const calls = [];
  const feed = new MinuteFeed(async url => {
    const u = new URL(url); calls.push([u.hostname, u.searchParams.get('code')]);
    if (blocked && u.hostname === 'web.ifzq.gtimg.cn') throw Object.assign(new Error('访问受限'), {statusCode:501});
    return minutePayload(u.searchParams.get('code'));
  }, ()=>now);
  assert.equal((await feed.load('sh600105')).backup, true);
  now += 10000; assert.equal((await feed.load('sz000001')).payload.data.sz000001.data.date, '20261026');
  assert.equal(calls.filter(c=>c[0] === 'web.ifzq.gtimg.cn').length, 1);
  now = WAF_COOLDOWN; blocked = false;
  assert.equal((await feed.load('sh600105')).backup, false);
  assert.equal(feed.failures.size, 0);
});

test('两源失败保留真实错误并退避；备用到期单独重试，不编造分时或把分钟K冒充均价', async () => {
  let now = 0, recovered = false; const calls = [];
  const feed = new MinuteFeed(async url => {
    const host = new URL(url).hostname; calls.push(host);
    if (host === 'web.ifzq.gtimg.cn') throw httpError(501);
    if (!recovered) throw httpError(503);
    return minutePayload('sh600105');
  }, ()=>now);
  await assert.rejects(feed.load('sh600105'), /主接口：数据接口 HTTP 501；备用接口：数据接口 HTTP 503/);
  now = 10000; await assert.rejects(feed.load('sh600105'), /暂不可用/); assert.equal(calls.length, 2);
  recovered = true; now = FAILURE_COOLDOWN;
  assert.equal((await feed.load('sh600105')).backup, true); assert.equal(calls.length, 3);
});

test('切股或关闭时取消主请求，不请求备用也不把取消当成接口故障；预取消无网络请求', async () => {
  const controller = new AbortController(); let calls = 0;
  const feed = new MinuteFeed(async () => { calls++; controller.abort(); throw Object.assign(new Error('cancelled'),{name:'AbortError'}); });
  await assert.rejects(feed.load('sh600105', controller.signal), /cancelled/);
  assert.equal(calls, 1); assert.equal(feed.failures.size, 0);
  await assert.rejects(feed.load('sz000001', controller.signal), /取消/); assert.equal(calls, 1);
});

test('请求成功但个股无数据时继续显示真实业务错误，不静默替换股票或图表周期', async () => {
  let calls = 0;
  const provider = new ChartProvider(async()=>{calls++;return {code:0,data:{}};});
  await assert.rejects(provider.load('600105','intraday'), /未获取到图表数据/); assert.equal(calls,1);
  await assert.rejects(provider.load('https://evil.example','intraday')); assert.equal(calls,1);
});

test('成交额与温度依赖的两市分时同步支持备用，计算快照与主源完全相同', async () => {
  const request = async url => {
    const u = new URL(url), symbol = u.searchParams.get('code');
    return u.pathname.includes('/minute/') ? minutePayload(symbol) : historyPayload(symbol);
  };
  const baseline = await new MarketProvider({request,now:()=>NOW}).load();
  const calls = [];
  const provider = new MarketProvider({now:()=>NOW,request:async url=>{
    calls.push(url); const u=new URL(url);
    if (u.hostname==='web.ifzq.gtimg.cn' && u.pathname.includes('/minute/')) throw httpError(501);
    return request(url);
  }});
  assert.deepEqual(await provider.load(),baseline);
  assert.equal(calls.length,6); assert.equal(calls.filter(url=>new URL(url).hostname==='ifzq.gtimg.cn').length,2);
  await provider.load(); assert.equal(calls.length,8);
  assert.deepEqual(SYMBOLS.map(symbol=>calls.filter(url=>url.includes('ifzq.gtimg.cn/appstock/app/minute/query?code='+symbol)).length),[3,3]);
});
