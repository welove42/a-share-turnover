'use strict';
const KEY = 'ai.conversations.v1';
const MAX_SESSIONS = 20, MAX_RECORD_CHARS = 500000, MAX_TOTAL_CHARS = 3000000;
const validTarget = value => value === 'market' || /^(?:sh|sz|bj)\d{6}$/.test(value || '');
function normalize(value) {
  if (!value || typeof value.id !== 'string' || !/^[a-f0-9-]{16,40}$/.test(value.id) || !validTarget(value.target)) return null;
  if (!Number.isFinite(value.updatedAt) || !Array.isArray(value.messages) || !Array.isArray(value.history)) return null;
  const messages = list => list.slice(-40).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({
    role: m.role, content: m.content.slice(0, 64000),
    ...(m.role === 'assistant' ? { state: ['complete', 'error', 'stopped'].includes(m.state) ? m.state : 'stopped',
      ...(typeof m.notice === 'string' ? { notice: m.notice.slice(0, 600) } : m.state === 'pending' ? { notice: '上次分析因窗口关闭而中断，可继续追问或重新分析。' } : {}) } : {})
  }));
  const history = list => list.slice(-20).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 100000) }));
  const record = { id: value.id, target: value.target, name: String(value.name || value.target).slice(0, 160),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : value.updatedAt, updatedAt: value.updatedAt,
    messages: messages(value.messages), history: history(value.history),
    interruptedHistory: Array.isArray(value.interruptedHistory) && value.interruptedHistory.length ? history(value.interruptedHistory) : null,
    snapshot: value.snapshot && typeof value.snapshot === 'object' ? value.snapshot : null,
    draft: typeof value.draft === 'string' ? value.draft.slice(0, 2000) : '' };
  const json = JSON.stringify(record);
  return json.length <= MAX_RECORD_CHARS ? JSON.parse(json) : null;
}
class AiHistoryStore {
  constructor(state) { this.state = state; this.write = Promise.resolve(); }
  read() {
    const saved = this.state.get(KEY, {}), sessions = [];
    let size = 0;
    for (const item of (Array.isArray(saved?.sessions) ? saved.sessions : []).slice(0, MAX_SESSIONS)) {
      const record = normalize(item); if (!record) continue;
      size += JSON.stringify(record).length; if (size > MAX_TOTAL_CHARS) break;
      sessions.push(record);
    }
    return { sessions, activeId: sessions.some(s => s.id === saved?.activeId) ? saved.activeId : null };
  }
  update(change) {
    // Read at execution time: multiple VS Code windows must not use a startup snapshot.
    const write = this.write.catch(() => {}).then(async () => {
      const data = this.read(); change(data);
      data.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      let size = 0;
      data.sessions = data.sessions.slice(0, MAX_SESSIONS).filter(s => { size += JSON.stringify(s).length; return size <= MAX_TOTAL_CHARS; });
      if (!data.sessions.some(s => s.id === data.activeId)) data.activeId = null;
      await this.state.update(KEY, data);
    });
    this.write = write; return write;
  }
  save(value) {
    const record = normalize(value);
    if (!record) return Promise.reject(new Error('对话内容过大，未能保存到本地。'));
    return this.update(data => { data.sessions = data.sessions.filter(s => s.id !== record.id); data.sessions.unshift(record); data.activeId = record.id; });
  }
  remove(id) { return this.update(data => { data.sessions = data.sessions.filter(s => s.id !== id); if (data.activeId === id) data.activeId = null; }); }
  clear() { return this.update(data => { data.sessions = []; data.activeId = null; }); }
}
module.exports = { AiHistoryStore, KEY, normalize, MAX_SESSIONS };
