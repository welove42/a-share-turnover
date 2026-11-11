import { completeTurn, endpoint } from './client';
import { CapabilityError } from './protocol';
import { TOOLS, applyEvidence, type QueryData } from './agent-data';
import { estimateTokens, snapshotText } from './agent-context';
import { abortError } from './data';
import type { AnalysisSnapshot, AgentReport, TurnOptions, TurnResult, ToolCall } from './types';

export type TurnRequest = (options: TurnOptions) => Promise<TurnResult>;
export interface AgentOptions extends TurnOptions {
  target: string;
  data: QueryData;
  request?: TurnRequest;
  onStatus?: (text: string) => void;
  onResetText?: () => void;
  onReport?: (report: AgentReport) => void;
  snapshot?: AnalysisSnapshot | null;
  onSnapshot?: (snapshot: AnalysisSnapshot) => void;
}
export const AGENT_LIMITS = { requests: 3, queries: 6, output: 3000, timeout: 180000 };

/** 每次用户操作最多三次模型请求；能力回退同样占预算，绝不重试鉴权/限流错误。 */
export class AnalysisAgent {
  private capabilities = new Map<string, { mode: 'agent' | 'compatible'; protocol: 'chat' | 'responses' }>();
  async run(options: AgentOptions): Promise<{ content: string; report: AgentReport; evidence: unknown[] }> {
    const parentSignal = options.signal,
      control = new AbortController();
    const cancel = () => control.abort();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    if (parentSignal?.aborted) cancel();
    let timedOut = false;
    const deadline = setTimeout(
      () => {
        timedOut = true;
        cancel();
      },
      Math.min(options.timeoutMs || AGENT_LIMITS.timeout, AGENT_LIMITS.timeout)
    );
    options = { ...options, signal: control.signal };
    const { request = completeTurn, data, target, onStatus = () => {}, onResetText = () => {} } = options;
    const key = endpoint(options.url) + ':' + options.model;
    const cached = this.capabilities.get(key);
    let mode = cached?.mode || 'agent';
    let protocol =
      cached?.protocol ||
      (endpoint(options.url).endsWith('/responses') ||
      (new URL(options.url).hostname === 'api.openai.com' && /^gpt-6(?:[.-]|$)/.test(options.model))
        ? 'responses'
        : 'chat');
    const report: AgentReport = {
      requests: 0,
      queries: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
      mode,
      limited: false
    };
    let messages = options.messages;
    const seen = new Map<string, Promise<string>>(),
      evidence: unknown[] = [];
    const started = Date.now();
    let content = '';
    // 缺口补查和模型发起的查询共用计数与去重；同一个工具不会因两条路径反复调用。
    const query = async (call: ToolCall) => {
      if (options.signal?.aborted) throw abortError();
      let args: any;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = null;
      }
      const defaults = {
        symbol: target === 'market' ? 'sh000001' : target,
        ...(call.function.name === 'get_technical' ? { period: 'daily', bars: 0 } : {}),
        ...(call.function.name === 'get_environment' ? { scope: 'sector' } : {})
      };
      const canonical = args && typeof args === 'object' && !Array.isArray(args) ? { ...defaults, ...args } : args;
      const signature =
        call.function.name +
        ':' +
        JSON.stringify(
          canonical && typeof canonical === 'object' ? Object.fromEntries(Object.entries(canonical).sort()) : canonical
        );
      let result: string;
      if (seen.has(signature)) result = await seen.get(signature)!;
      else if (report.queries >= AGENT_LIMITS.queries) {
        report.limited = true;
        result = '{"missing":true,"reason":"查询次数已用完，请根据已有数据回答。"}';
      } else {
        report.queries++;
        const pending = (async () => {
          let value: any;
          try {
            value = await data.execute(call.function.name, args, target, options.signal!);
          } catch {
            if (options.signal?.aborted) throw abortError();
            value = { missing: true, reason: '查询失败或参数不支持，不得补猜。' };
          }
          if (options.signal?.aborted) throw abortError();
          // 数据适配器已限制条数；保留它返回的完整证据，不能再按 token 裁成缺少来源和日期的片段。
          value ??= { missing: true, reason: '工具未返回有效数据。' };
          evidence.push({ tool: call.function.name, args, data: value });
          return JSON.stringify(value);
        })();
        seen.set(signature, pending);
        result = await pending;
      }
      return { role: 'tool' as const, tool_call_id: call.id, content: result };
    };
    try {
      const missing = options.snapshot
        ? data.missingQueries?.(options.snapshot, target, messages.at(-1)?.content || '') || []
        : [];
      if (missing.length) {
        const selected = missing.slice(0, AGENT_LIMITS.queries);
        if (selected.length < missing.length) report.limited = true;
        onStatus('正在自动补查缺失数据：' + selected.map((item) => item.label).join(' / ') + '…');
        await Promise.all(
          selected.map((item, index) =>
            query({
              id: `repair-${index}`,
              type: 'function',
              function: { name: item.name, arguments: JSON.stringify(item.args) }
            })
          )
        );
        if (options.signal?.aborted) throw abortError();
        const updated = applyEvidence(options.snapshot!, target, evidence);
        updated.coverage = [
          ...(updated.coverage || []).filter((c) => c.label !== '自动补查'),
          { label: '自动补查', detail: selected.map((item) => item.label).join(' / ') }
        ];
        options.onSnapshot?.(updated);
        messages = messages.map((m) =>
          m.content.startsWith('当前行情快照')
            ? { ...m, content: '当前行情快照（逐项核对数据时间）：\n' + snapshotText(updated) }
            : m
        );
        // 明确补查结果，包括失败原因；正文不能把“未提供”当作“不去查”的理由。
        const attempts = evidence.map((item: any) => ({
          tool: item.tool,
          args: item.args,
          missing: !!(item.data.missing || item.data.sectors?.missing || item.data.market?.turnoverMissing),
          fetchFailed: !!item.data.fetchFailed,
          reason: item.data.error || item.data.reason || item.data.sectors?.reason
        }));
        messages = [
          ...messages.slice(0, -1),
          {
            role: 'user',
            content:
              '本轮已自动补查以下缺口，结果已合入当前行情快照；仍缺失须说明实际原因，不重复查询：\n' +
              JSON.stringify(attempts)
          },
          messages.at(-1)!
        ];
      }
      while (report.requests < AGENT_LIMITS.requests) {
        if (options.signal?.aborted) throw abortError();
        const final =
          report.requests === AGENT_LIMITS.requests - 1 ||
          report.queries >= AGENT_LIMITS.queries ||
          report.outputTokens > 1500;
        const tools = !final && mode === 'agent' ? TOOLS : [];
        if (!tools.length)
          messages = [
            {
              ...messages[0],
              content:
                messages[0].content +
                '\n本轮查询已结束或接口不支持工具；根据已有数据回答，缺失处说明限制，不再提出工具调用。'
            },
            ...messages.slice(1)
          ];
        const input = estimateTokens({ messages, tools });
        if (AGENT_LIMITS.output - report.outputTokens < 300) {
          report.limited = true;
          break;
        }
        const timeoutMs = Math.min(
          options.timeoutMs || AGENT_LIMITS.timeout,
          AGENT_LIMITS.timeout - (Date.now() - started)
        );
        if (timeoutMs <= 0) throw new Error('AI 分析达到总等待时限，已停止补查。');
        report.requests++;
        const outputLimit = Math.min(1800, AGENT_LIMITS.output - report.outputTokens);
        let turn: TurnResult;
        try {
          turn = await request({
            ...options,
            messages,
            protocol,
            tools,
            maxTokens: outputLimit,
            timeoutMs,
            onDelta: (text) => options.onDelta?.(text)
          });
        } catch (error) {
          // 即使失败也保守记录本次输入；没有 usage 时不声称精确用量。
          report.inputTokens += input;
          report.outputTokens += error instanceof CapabilityError ? 0 : outputLimit;
          report.estimated = true;
          if (
            !(error instanceof CapabilityError) ||
            report.requests >= AGENT_LIMITS.requests ||
            options.signal?.aborted
          )
            throw error;
          if (error.capability === 'responses' && protocol === 'chat') protocol = 'responses';
          else if (error.capability === 'tools' && mode === 'agent') mode = 'compatible';
          else throw error;
          report.mode = mode;
          this.capabilities.set(key, { mode, protocol });
          onResetText();
          onStatus(mode === 'compatible' ? '接口不支持工具调用，使用已更新行情进行兼容分析…' : '正在适配模型接口…');
          continue;
        }
        report.inputTokens += turn.usage?.prompt_tokens ?? input;
        // 缺少 usage 时按本次输出上限预扣，避免隐藏推理未计入而连续超支。
        report.outputTokens += turn.usage?.completion_tokens ?? outputLimit;
        report.estimated ||=
          !Number.isFinite(turn.usage?.prompt_tokens) || !Number.isFinite(turn.usage?.completion_tokens);
        if (!turn.calls.length) {
          content = turn.content;
          this.capabilities.set(key, { mode, protocol });
          break;
        }
        if (final || mode === 'compatible') {
          report.limited = true;
          break;
        }
        onResetText();
        onStatus('正在补查行情与相关数据…');
        const results = await Promise.all(turn.calls.map(query));
        messages = [
          ...messages,
          { role: 'assistant', content: turn.content, tool_calls: turn.calls, responseItems: turn.responseItems },
          ...results
        ];
        if (report.outputTokens >= AGENT_LIMITS.output) report.limited = true;
      }
      if (!content.trim()) throw new Error('AI 本轮已达到查询或用量上限，尚未生成完整结论；请缩小问题范围。');
      return { content, report, evidence };
    } catch (error) {
      if (timedOut) throw new Error('AI 分析达到总等待时限，已停止补查并保留已收到的内容。');
      throw error;
    } finally {
      clearTimeout(deadline);
      parentSignal?.removeEventListener('abort', cancel);
      options.onReport?.({ ...report });
    }
  }
}
