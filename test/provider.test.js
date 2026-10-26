'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MarketProvider } = require('../src/provider');
const { minutePayload, historyPayload } = require('./fixtures');
const NOW = new Date('2026-10-26T10:30:30+08:00');

test('初次获取历史，其后只获取实时；手动刷新可重取历史', async () => {
  const calls = [];
  const provider = new MarketProvider({ now: () => NOW, request: async url => {
    calls.push(url); const symbol = new URL(url).searchParams.get('code');
    return url.includes('/minute/') ? minutePayload(symbol) : historyPayload(symbol);
  } });
  const result = await provider.load();
  assert.ok(result.sameTime);
  assert.equal(calls.filter(url => url.includes('/day/')).length, 2);
  await provider.load();
  assert.equal(calls.length, 6);
  await provider.load(undefined, true);
  assert.equal(calls.filter(url => url.includes('/day/')).length, 4);
});

test('历史服务故障时保留实时报价，60秒后重试基准', async () => {
  let now = NOW, attempts = 0;
  const provider = new MarketProvider({ now: () => now, request: async url => {
    const symbol = new URL(url).searchParams.get('code');
    if (url.includes('/day/')) { attempts++; throw new Error('历史暂不可用'); }
    return minutePayload(symbol);
  } });
  const result = await provider.load();
  assert.equal(result.amount, 400e8);
  assert.equal(result.sameTime, null);
  await provider.load(); assert.equal(attempts, 2);
  now = new Date(NOW.getTime() + 60000);
  await provider.load(); assert.equal(attempts, 4);
});

test('单市请求失败不显示另一市的部分总额，且等待全部请求结束', async () => {
  let settled = false;
  const provider = new MarketProvider({ request: async url => {
    const symbol = new URL(url).searchParams.get('code');
    if (symbol === 'sh000002') throw new Error('沪市故障');
    await new Promise(resolve => setTimeout(resolve, 20));
    settled = true;
    return minutePayload(symbol);
  } });
  await assert.rejects(provider.load(), /沪市故障/);
  assert.equal(settled, true);
});

test('跨交易日不复用旧的昨日基准', async () => {
  let secondDay = false;
  const provider = new MarketProvider({ now: () => NOW, request: async url => {
    const symbol = new URL(url).searchParams.get('code');
    if (url.includes('/minute/')) return minutePayload(symbol, 200e8, secondDay ? '20261027103030' : '20261026103030');
    return historyPayload(symbol);
  } });
  assert.ok((await provider.load()).sameTime);
  secondDay = true;
  assert.equal((await provider.load()).sameTime, null);
});

test('取消请求后不返回快照', async () => {
  const controller = new AbortController(); controller.abort();
  const provider = new MarketProvider({ request: async url => minutePayload(new URL(url).searchParams.get('code')) });
  await assert.rejects(provider.load(controller.signal), /已取消/);
});
