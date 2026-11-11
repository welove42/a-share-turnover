import type { AgentMessage, AnalysisSnapshot, ChatMessage } from './types';
import { analysisPayload } from './technical-context';
import { usableMemory, type ConversationMemory } from './conversation-memory';
export { estimateTokens } from './token-budget';

/** 行情源已按标的和周期生成摘要。这里只去除重复的界面/工具记录，不再按 token 删掉数据区块。 */
export function snapshotText(snapshot: AnalysisSnapshot | null): string {
  const raw = analysisPayload(snapshot);
  if (!raw) return '{}';
  const { agent: _, ...data } = raw as typeof raw & { agent?: unknown };
  return JSON.stringify(data);
}

/** 成功摘要覆盖的旧记录由记忆替代；尚未摘要或摘要失败的问答保留完整原文。 */
export function conversationContext(
  history: ChatMessage[],
  previous?: ConversationMemory,
  _question = ''
): AgentMessage[] {
  const memory = usableMemory(previous, history);
  const clean = history
    .slice(memory?.covered || 0)
    .filter((m) => ['user', 'assistant'].includes(m.role))
    .map((m) => ({
      role: m.role,
      // 兼容早期把行情包当用户首条消息保存的版本；旧行情以当前独立快照为准。
      content: m.content.startsWith('分析以下多周期行情快照：') ? '请综合分析当前标的。' : m.content
    }));
  return [
    ...(memory
      ? [
          {
            role: 'user' as const,
            content:
              '会话记忆（模型生成的历史摘要；旧结论不是当前事实；用户原话和更正优先）：\n' +
              JSON.stringify(memory.facts)
          }
        ]
      : []),
    ...clean
  ];
}
