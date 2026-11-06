/** 与服务商传输的消息和仅供界面显示的状态分开，状态文字不会进入提示词。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export type RequestPhase = 'connecting' | 'waiting' | 'reasoning' | 'answering';
export interface AnalysisMessage extends ChatMessage {
  state?: 'pending' | 'complete' | 'error' | 'stopped';
  phase?: RequestPhase;
  elapsedSeconds?: number;
  notice?: string;
}
export interface AiConfiguration {
  url: string;
  model: string;
}
export interface DiagnosticCounters {
  outcome:
    | 'error'
    | 'complete'
    | 'cancelled'
    | 'idle_timeout'
    | 'total_timeout'
    | 'http_error'
    | 'stream_ended_without_finish'
    | 'length_limit';
  httpStatus: number | null;
  headersMs?: number;
  firstByteMs: number | null;
  firstContentMs: number | null;
  lastByteMs: number | null;
  lastContentMs: number | null;
  events: number;
  contentEvents: number;
  reasoningEvents: number;
  heartbeatEvents: number;
  unknownEvents: number;
  finishReason: string | null;
  doneSeen: boolean;
  usage?: Record<string, number>;
  networkCode?: string;
}
/** 诊断数据明确不允许携带密钥、提示词、原始正文和思考内容。 */
export interface AiDiagnostic extends DiagnosticCounters {
  at?: string;
  elapsedMs: number;
  bytes: number;
  contentChars: number;
  idleTimeoutMs: number;
  timeoutMs: number;
}
export interface CompletionOptions {
  url: string;
  model: string;
  key: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onProgress?: (phase: RequestPhase) => void;
  onDiagnostic?: (value: AiDiagnostic) => void;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxTokens?: number;
}

/** 不同数据源字段会随市场变化；仅此边界保留开放字段，消息及状态本身是固定合同。 */
export type PublicMarketSection = Record<string, any>;
export interface AnalysisSnapshot {
  target: string;
  capturedAt: string;
  timeZone: string;
  notes: string[];
  quote?: PublicMarketSection;
  daily?: PublicMarketSection;
  market?: PublicMarketSection;
  sectors?: PublicMarketSection;
  globalMarkets?: PublicMarketSection;
  commodities?: PublicMarketSection;
  news?: PublicMarketSection;
  relativeStrength?: { unit: string; comparisons: Array<{ name: string; difference: number }>; note: string };
  coverage?: Array<{ label: string; detail: string }>;
}
export interface AiConversation {
  id: string;
  target: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messages: AnalysisMessage[];
  history: ChatMessage[];
  interruptedHistory: ChatMessage[] | null;
  snapshot: AnalysisSnapshot | null;
  draft: string;
}
export interface AiArchive {
  sessions: AiConversation[];
  activeId: string | null;
}
export interface HistoryItem {
  id: string;
  name: string;
  createdAt: number;
  preview: string;
}
