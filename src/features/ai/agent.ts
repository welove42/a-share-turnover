import { completeTurn, endpoint } from './client';
import { CapabilityError } from './protocol';
import { TOOLS, type QueryData } from './agent-data';
import { estimateTokens, fitMessages, pack } from './agent-context';
import { abortError } from './data';
import type { AgentMessage, AgentReport, TurnOptions, TurnResult } from './types';

export type TurnRequest = (options: TurnOptions) => Promise<TurnResult>;
export interface AgentOptions extends TurnOptions {
  target: string;
  data: QueryData;
  request?: TurnRequest;
  onStatus?: (text: string) => void;
  onResetText?: () => void;
  onReport?: (report: AgentReport) => void;
}
export const AGENT_LIMITS = { requests: 3, queries: 6, input: 12000, output: 3000, timeout: 180000 };

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
    const base = [...messages],
      seen = new Map<string, Promise<string>>(),
      evidence: unknown[] = [];
    const started = Date.now();
    let content = '';
    try {
      while (report.requests < AGENT_LIMITS.requests) {
        if (options.signal?.aborted) throw abortError();
        const final =
          report.requests === AGENT_LIMITS.requests - 1 ||
          report.queries >= AGENT_LIMITS.queries ||
          report.outputTokens > 1500 ||
          report.inputTokens >= 6000;
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
        let input = estimateTokens({ messages, tools });
        const remaining = AGENT_LIMITS.input - report.inputTokens;
        if (input > Math.min(5500, remaining)) {
          // 重新构造完整文本请求，不能截断成孤立的 tool 消息或丢失 call_id 配对。
          messages = fitMessages(
            [messages[0], ...base.slice(1)],
            evidence,
            Math.min(5500, remaining) - estimateTokens(tools) - 80
          );
          input = estimateTokens({ messages, tools });
        }
        if (input > remaining || AGENT_LIMITS.output - report.outputTokens < 300) {
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
        // 预留最终回答输入/输出额度；最多执行六次工具，即使模型一次返回很多调用。
        const results = await Promise.all(
          turn.calls.map(async (call) => {
            let result: string;
            let args: any;
            try {
              args = JSON.parse(call.function.arguments);
            } catch {
              args = null;
            }
            const signature =
              call.function.name +
              ':' +
              JSON.stringify(args && typeof args === 'object' ? Object.fromEntries(Object.entries(args).sort()) : args);
            if (seen.has(signature)) result = await seen.get(signature)!;
            else if (report.queries >= AGENT_LIMITS.queries) {
              report.limited = true;
              result = '{"missing":true,"reason":"查询预算已用完，请根据已有数据回答。"}';
            } else {
              report.queries++;
              onStatus('正在补查行情与相关数据…');
              const pending = (async () => {
                let value: string;
                try {
                  value = pack(await data.execute(call.function.name, args, target, options.signal!), 1000);
                } catch (error) {
                  if (options.signal?.aborted) throw abortError();
                  value = '{"missing":true,"reason":"查询失败或参数不支持，不得补猜。"}';
                }
                evidence.push({ tool: call.function.name, args, data: JSON.parse(value) });
                return value;
              })();
              seen.set(signature, pending);
              result = await pending;
            }
            return { role: 'tool' as const, tool_call_id: call.id, content: result };
          })
        );
        messages = [
          ...messages,
          { role: 'assistant', content: turn.content, tool_calls: turn.calls, responseItems: turn.responseItems },
          ...results
        ];
        if (report.inputTokens >= AGENT_LIMITS.input || report.outputTokens >= AGENT_LIMITS.output)
          report.limited = true;
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
