'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { AiHistoryStore, KEY, MAX_SESSIONS } = require('../src/ai-history');
const record = i => ({ id: String(i).padStart(16, '0'), target: 'market', createdAt: i, updatedAt: i,
  messages: [{ role: 'user', content: '分析大盘' }, { role: 'assistant', content: '回复', state: 'complete' }],
  history: [{ role: 'user', content: '行情快照' }, { role: 'assistant', content: '回复' }], snapshot: { quote: { price: i } } });
function store() { const map = new Map(); return { map, state: { get: (k, d) => map.get(k) ?? d, update: async (k, v) => { map.set(k, v); } } }; }
test('本地历史限制20段并按新旧排序，删除串行写入不会被旧保存复活', async () => {
  const { state } = store(), s = new AiHistoryStore(state);
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.save(record(i))));
  assert.equal(s.read().sessions.length, MAX_SESSIONS); assert.equal(s.read().sessions[0].updatedAt, 24);
  void s.save(record(30)); await s.remove(record(30).id);
  assert.equal(s.read().sessions.some(r => r.id === record(30).id), false);
  await s.clear(); assert.deepEqual(s.read(), { sessions: [], activeId: null });
});
test('坏数据被跳过，保存只接受明确字段，超大记录拒绝且不覆盖历史', async () => {
  const { state, map } = store(), s = new AiHistoryStore(state);
  map.set(KEY, { sessions: [null, {}, { ...record(1), target: 'file:///secret' }], activeId: 'bad' });
  assert.deepEqual(s.read(), { sessions: [], activeId: null });
  const value = { ...record(2), key: 'not-for-disk', url: 'https://secret.example', arbitrary: 'ignored' };
  await s.save(value); assert.doesNotMatch(JSON.stringify(s.read()), /not-for-disk|secret.example|arbitrary/);
  value.messages[1].content = 'changed outside'; assert.equal(s.read().sessions[0].messages[1].content, '回复');
  await assert.rejects(s.save({ ...record(3), snapshot: { oversized: 'x'.repeat(500001) } }), /过大/);
  assert.equal(s.read().sessions.length, 1);
});
test('写入失败可以重试，不会一直卡在失败队列', async () => {
  const { state } = store(), update = state.update; let fail = true;
  state.update = async (...args) => { if (fail) throw new Error('disk full'); return update(...args); };
  const s = new AiHistoryStore(state); await assert.rejects(s.save(record(1)), /disk full/);
  fail = false; await s.save(record(2)); assert.equal(s.read().sessions[0].updatedAt, 2);
});
