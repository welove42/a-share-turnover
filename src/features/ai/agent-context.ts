import type { AgentMessage, AnalysisSnapshot, ChatMessage } from './types';
import { analysisPayload } from './technical-context';

/** 无通用服务商 tokenizer 时使用保守估算；诊断必须标为估算，不能冒充账单。 */
export const estimateTokens = (value: unknown) =>
  Math.ceil(Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') / 2) + 16;

function compact(value: any, count: number, text: number, depth = 0): any {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > text ? value.slice(0, text) + '…[节选]' : value;
  if (depth > 7) return '[细节略，可按需查询]';
  if (Array.isArray(value)) return value.slice(0, count).map((v) => compact(v, count, text, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([k, v]) => [k, compact(v, count, text, depth + 1)])
  );
}

export function pack(value: unknown, limit = 1800): string {
  if (value === undefined) return 'null';
  for (const [count, text] of [
    [10, 350],
    [5, 220],
    [3, 140],
    [1, 80]
  ]) {
    const data = compact(value, count, text);
    const encoded = JSON.stringify(data);
    if (estimateTokens(encoded) <= limit) return encoded;
  }
  return JSON.stringify({ omitted: true, reason: '结果超过本轮上下文预算，请缩小查询范围。' });
}

export function snapshotText(snapshot: AnalysisSnapshot | null): string {
  const raw = analysisPayload(snapshot);
  if (!raw) return '{}';
  const { agent: _, ...data } = raw as typeof raw & { agent?: unknown };
  // 各周期保留主要结论、时间及证据；冗长外围明细由工具按需补齐。
  const parts: Record<string, unknown> = {};
  const recent: Record<string, { recentBars: unknown[]; recentBarsOrder: string }> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'market' && v) {
      const { history: _, ...market } = v as Record<string, unknown>;
      parts[k] = JSON.parse(pack(market, 650));
    } else if (k === 'timeframes' && v) {
      parts[k] = Object.fromEntries(
        Object.entries(v).map(([period, values]) => {
          if (!values || typeof values !== 'object') return [period, values];
          const t = values as Record<string, any>;
          const { bars: _, ranges, recentBars, recentBarsOrder, ...rest } = t;
          if (Array.isArray(recentBars) && recentBars.length)
            recent[period] = { recentBars: recentBars.slice(0, period === 'daily' ? 10 : 6), recentBarsOrder: recentBarsOrder || '新到旧' };
          return [
            period,
            JSON.parse(pack({ ...rest, ...(ranges ? { ranges: { prior20: ranges.prior20 } } : {}) }, 850))
          ];
        })
      );
    } else parts[k] = JSON.parse(pack(v, ['sectors', 'globalMarkets'].includes(k) ? 550 : 400));
  }
  // 先为近期 K 线预留预算，避免通用压缩把多日序列截到只剩一根。
  const budget = Math.max(500, 3600 - estimateTokens(recent) - 100);
  const result = JSON.parse(pack(parts, budget));
  if (Object.keys(recent).length) {
    if (result.omitted) Object.assign(result, { target: data.target, capturedAt: data.capturedAt });
    result.timeframes ||= {};
    for (const [period, value] of Object.entries(recent))
      result.timeframes[period] = { ...(result.timeframes[period] || {}), ...value };
  }
  return JSON.stringify(result);
}

/** 只发送最近三轮和更早问答的短摘录，原始会话仍由本地历史保存。 */
export function conversationContext(history: ChatMessage[]): AgentMessage[] {
  const clean = history
    .filter((m) => ['user', 'assistant'].includes(m.role))
    .map((m) => ({
      role: m.role,
      content: m.content.startsWith('分析以下多周期行情快照：') ? '请综合分析当前标的。' : m.content
    }));
  const recent = clean
    .slice(-6)
    .map((m) => ({ ...m, content: m.content.slice(0, 900) + (m.content.length > 900 ? '…[历史节选]' : '') }));
  const older = clean
    .slice(0, -6)
    .slice(-8)
    .map((m) => `${m.role === 'user' ? '问' : '旧答'}：${m.content.slice(0, 100)}`)
    .join('\n');
  return [
    ...(older ? [{ role: 'user' as const, content: '较早讨论节选（旧结论，不是当前事实）：\n' + older }] : []),
    ...recent
  ];
}

/** 预算收紧时保留可解析的事实；不能把 JSON 当长字符串截成失去日期的碎片。 */
export function fitMessages(base: AgentMessage[], evidence: unknown[], available: number): AgentMessage[] {
  const system = base[0],
    question = base.at(-1)!;
  const dataMessage = base.find((m) => m.content.startsWith('当前行情快照'));
  let snapshot: any;
  try {
    snapshot = dataMessage ? JSON.parse(dataMessage.content.slice(dataMessage.content.indexOf('\n') + 1)) : {};
  } catch {
    snapshot = {};
  }
  const minimal = {
    target: snapshot.target,
    capturedAt: snapshot.capturedAt,
    quote: snapshot.quote,
    timeframes: Object.fromEntries(
      Object.entries(snapshot.timeframes || {}).map(([p, v]: [string, any]) => [
        p,
        {
          date: v.date,
          fetchedAt: v.fetchedAt,
          source: v.source,
          adjustment: v.adjustment,
          state: v.state,
          forming: v.forming,
          confirmedThrough: v.confirmedThrough,
          developing: v.developing ? { time: v.developing.time, close: v.developing.close } : undefined,
          indicators: v.indicators ? { MA20: v.indicators.MA20, MA60: v.indicators.MA60 } : undefined
        }
      ])
    ),
    market: snapshot.market
      ? {
          amount: snapshot.market.amount,
          sameTime: snapshot.market.sameTime,
          temperature: snapshot.market.temperature,
          benchmarks: snapshot.market.benchmarks
        }
      : undefined,
    sectors: snapshot.sectors
      ? { industry: snapshot.sectors.industry, fetchedAt: snapshot.sectors.fetchedAt, cached: snapshot.sectors.cached }
      : undefined,
    globalMarkets: snapshot.globalMarkets,
    etf: snapshot.etf,
    notes: snapshot.notes
  };
  const quota = Math.max(100, available - estimateTokens([system, question]) - 100);
  const recent: Record<string, { recentBars: any[]; recentBarsOrder: string }> = {};
  for (const [period, v] of Object.entries(snapshot.timeframes || {}) as Array<[string, any]>)
    if (Array.isArray(v.recentBars) && v.recentBars.length)
      recent[period] = { recentBars: v.recentBars.slice(), recentBarsOrder: v.recentBarsOrder || '新到旧' };
  // 预算不足时先丢弃最旧的样本，保留最新几根而不是截掉最近日期。
  while (estimateTokens(recent) > Math.max(100, quota / 2)) {
    const longest = Object.values(recent).sort((a, b) => b.recentBars.length - a.recentBars.length)[0];
    if (!longest || longest.recentBars.length <= 1) break;
    longest.recentBars.pop();
  }
  const prior = base
    .filter((m) => m.role === 'assistant')
    .at(-1)
    ?.content.slice(0, 300);
  const compressed = JSON.parse(pack({ snapshot: minimal, latestEvidence: evidence, previousAnswer: prior }, Math.max(100, quota - estimateTokens(recent) - 40)));
  if (Object.keys(recent).length) {
    compressed.snapshot ||= { target: snapshot.target, capturedAt: snapshot.capturedAt };
    compressed.snapshot.timeframes ||= {};
    for (const [period, value] of Object.entries(recent))
      compressed.snapshot.timeframes[period] = { ...(compressed.snapshot.timeframes[period] || {}), ...value };
  }
  return [
    system,
    {
      role: 'user',
      content:
        '以下按预算精简；新补查结果优先，缺失信息不能补猜。\n' +
        JSON.stringify(compressed)
    },
    question
  ];
}
