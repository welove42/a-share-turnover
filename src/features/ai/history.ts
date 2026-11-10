/** 仅在 VS Code 本机状态中保存会话。串行写入和容量上限避免流式更新互相覆盖、无限增长。 */
import type { Memento } from 'vscode';
import type { AiConversation, AiArchive, ChatMessage, AnalysisMessage } from './types';
const KEY = 'ai.conversations.v1';
const MAX_SESSIONS = 20,
  MAX_RECORD_CHARS = 500000,
  MAX_TOTAL_CHARS = 3000000;
const validTarget = (value) => value === 'market' || /^(?:sh|sz|bj)\d{6}$/.test(value || '');
function normalize(value: any): AiConversation | null {
  if (!value || typeof value.id !== 'string' || !/^[a-f0-9-]{16,40}$/.test(value.id) || !validTarget(value.target))
    return null;
  if (!Number.isFinite(value.updatedAt) || !Array.isArray(value.messages) || !Array.isArray(value.history)) return null;
  const messages = (list: AnalysisMessage[]): AnalysisMessage[] =>
    list
      .slice(-120)
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .map((m) => ({
        role: m.role,
        content: m.content.slice(0, 64000),
        ...(m.role === 'assistant'
          ? {
              state: ['complete', 'error', 'stopped'].includes(m.state || '')
                ? (m.state as AnalysisMessage['state'])
                : 'stopped',
              ...(typeof m.notice === 'string'
                ? { notice: m.notice.slice(0, 600) }
                : m.state === 'pending'
                  ? { notice: '上次分析因窗口关闭而中断，可继续追问或重新分析。' }
                  : {})
            }
          : {})
      }));
  const history = (list: ChatMessage[]): ChatMessage[] =>
    list
      .slice(-120)
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 100000) }));
  const record: AiConversation = {
    id: value.id,
    target: value.target,
    name: String(value.name || value.target).slice(0, 160),
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : value.updatedAt,
    updatedAt: value.updatedAt,
    messages: messages(value.messages),
    history: history(value.history),
    interruptedHistory:
      Array.isArray(value.interruptedHistory) && value.interruptedHistory.length
        ? history(value.interruptedHistory)
        : null,
    snapshot: value.snapshot && typeof value.snapshot === 'object' ? value.snapshot : null,
    draft: typeof value.draft === 'string' ? value.draft.slice(0, 2000) : ''
  };
  const json = JSON.stringify(record);
  return json.length <= MAX_RECORD_CHARS ? JSON.parse(json) : null;
}
class AiHistoryStore {
  declare state: Memento;
  declare write: Promise<void>;

  constructor(state: Memento) {
    this.state = state;
    this.write = Promise.resolve();
  }
  read(): AiArchive {
    const saved = this.state.get<Partial<AiArchive>>(KEY, {}),
      sessions: AiConversation[] = [];
    let size = 0;
    for (const item of (Array.isArray(saved?.sessions) ? saved.sessions : []).slice(0, MAX_SESSIONS)) {
      const record = normalize(item);
      if (!record) continue;
      size += JSON.stringify(record).length;
      if (size > MAX_TOTAL_CHARS) break;
      sessions.push(record);
    }
    return { sessions, activeId: sessions.some((s) => s.id === saved?.activeId) ? saved.activeId! : null };
  }
  update(change: (archive: AiArchive) => void): Promise<void> {
    // Read at execution time: multiple VS Code windows must not use a startup snapshot.
    const write = this.write
      .catch(() => {})
      .then(async () => {
        const data = this.read();
        change(data);
        data.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        let size = 0;
        data.sessions = data.sessions.slice(0, MAX_SESSIONS).filter((s) => {
          size += JSON.stringify(s).length;
          return size <= MAX_TOTAL_CHARS;
        });
        if (!data.sessions.some((s) => s.id === data.activeId)) data.activeId = null;
        await this.state.update(KEY, data);
      });
    this.write = write;
    return write;
  }
  save(value: AiConversation): Promise<void> {
    const record = normalize(value);
    if (!record) return Promise.reject(new Error('对话内容过大，未能保存到本地。'));
    return this.update((data) => {
      data.sessions = data.sessions.filter((s) => s.id !== record.id);
      data.sessions.unshift(record);
      data.activeId = record.id;
    });
  }
  remove(id: string): Promise<void> {
    return this.update((data) => {
      data.sessions = data.sessions.filter((s) => s.id !== id);
      if (data.activeId === id) data.activeId = null;
    });
  }
  clear() {
    return this.update((data) => {
      data.sessions = [];
      data.activeId = null;
    });
  }
}
export { AiHistoryStore, KEY, normalize, MAX_SESSIONS };
