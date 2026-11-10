import type { AgentMessage, ToolCall, TurnOptions } from './types';

export class CapabilityError extends Error {
  constructor(public capability: 'tools' | 'responses') {
    super(capability === 'tools' ? 'AI 接口不支持工具调用，切换兼容分析。' : 'AI 模型需要 Responses 协议。');
  }
}

/** 只识别明确的能力拒绝；鉴权、限流、余额和模型不存在不能触发协议降级。 */
export async function capabilityError(response: Response): Promise<CapabilityError | undefined> {
  if (![400, 422].includes(response.status) || !response.body) return;
  const reader = response.body.getReader();
  let raw = '',
    size = 0;
  try {
    const decoder = new TextDecoder();
    while (size < 16384) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      raw += decoder.decode(part.value, { stream: true });
    }
    if (/responses\s*(?:api|endpoint)|\/responses/i.test(raw) && /only|require|instead|not supported/i.test(raw))
      return new CapabilityError('responses');
    if (
      /\b(?:tools|tool_choice|function.calling|tool.calls)\b/i.test(raw) &&
      /not support|unsupported|not available|not allowed|unknown (?:field|parameter)|unrecognized/i.test(raw)
    )
      return new CapabilityError('tools');
  } finally {
    // 原始服务商错误可能含凭据或请求正文，只用于分类，不进入日志与界面。
    void reader.cancel().catch(() => {});
  }
}

export function responsesInput(messages: AgentMessage[]): Record<string, any>[] {
  return messages.flatMap((m): Record<string, any>[] => {
    if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: m.content }];
    if (m.responseItems?.length) return m.responseItems;
    if (m.tool_calls?.length)
      return [
        ...(m.content ? [{ role: 'assistant', content: m.content }] : []),
        ...m.tool_calls.map((c) => ({
          type: 'function_call',
          call_id: c.id,
          name: c.function.name,
          arguments: c.function.arguments
        }))
      ];
    return [{ role: m.role, content: m.content }];
  });
}

export function responsesBody(options: TurnOptions) {
  return {
    model: options.model,
    input: responsesInput(options.messages),
    stream: true,
    store: false,
    max_output_tokens: options.maxTokens,
    include: ['reasoning.encrypted_content'],
    ...(options.tools?.length
      ? {
          tools: options.tools.map((t) => ({ type: 'function', ...t.function, strict: false })),
          tool_choice: 'auto'
        }
      : {})
  };
}

export function validateCalls(calls: ToolCall[]): ToolCall[] {
  const ids = new Set<string>();
  for (const c of calls) {
    if (
      !c.id ||
      c.id.length > 200 ||
      ids.has(c.id) ||
      c.type !== 'function' ||
      !/^[a-zA-Z0-9_]{1,64}$/.test(c.function?.name || '') ||
      typeof c.function?.arguments !== 'string' ||
      c.function.arguments.length > 16000
    )
      throw new Error('AI 工具调用格式不完整，未执行查询。');
    ids.add(c.id);
  }
  if (calls.length > 32) throw new Error('AI 工具调用数量超过限制，未执行查询。');
  return calls;
}
