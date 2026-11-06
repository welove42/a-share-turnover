import type { ChatMessage, CompletionOptions, RequestPhase, DiagnosticCounters, AiDiagnostic } from './types';
import { createHash } from 'node:crypto';

function endpoint(value: unknown): string {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('请填写有效的 API 地址，例如 https://api.example.com/v1');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error('API 地址必须使用 HTTPS；本机服务可使用 HTTP。');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('API 地址不能包含账号、密码、查询参数或锚点。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}
function secretId(url: string): string {
  return 'ai.apiKey.' + createHash('sha256').update(endpoint(url)).digest('hex');
}
function modelName(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model || model.length > 160 || /[\r\n\x00-\x1f]/.test(model))
    throw new Error('请填写服务商提供的模型名称（最多 160 字符）。');
  return model;
}
function httpError(status: number): Error {
  const hints: Record<number, string> = {
    400: '请检查模型名称及接口是否兼容 Chat Completions',
    401: 'API Key 无效或已过期，请重新设置',
    403: '没有调用权限，请检查服务商授权',
    404: '接口路径或模型不存在，请检查 API 地址和模型名称',
    429: '请求受限或余额不足，请稍后重试或检查服务商账户'
  };
  return new Error(`AI 接口 HTTP ${status}：${hints[status] || '服务暂不可用，请稍后重试'}`);
}
function requestBody(address: string, model: string, messages: ChatMessage[], maxTokens: number) {
  const body: {
    model: string;
    messages: ChatMessage[];
    stream: true;
    max_completion_tokens?: number;
    max_tokens?: number;
  } = { model, messages, stream: true };
  if (new URL(address).hostname === 'api.openai.com') {
    // The modern OpenAI limit includes reasoning as well as visible output.
    const reasoning = /^(?:o[1-9](?:-|$)|gpt-[56](?:[.-]|$))/.test(model);
    body.max_completion_tokens = maxTokens + (reasoning ? (maxTokens <= 128 ? 1024 : 4096) : 0);
  } else body.max_tokens = maxTokens;
  return body;
}
// No redirects, provider error bodies, reasoning text or request headers enter the UI/logs.
async function complete({
  url,
  model,
  key,
  messages,
  signal,
  onDelta = () => {},
  onProgress = () => {},
  onDiagnostic = () => {},
  timeoutMs = 180000,
  idleTimeoutMs = 90000,
  maxTokens = 2200
}: CompletionOptions): Promise<string> {
  const address = endpoint(url),
    name = modelName(model);
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key))
    throw new Error('请先为当前 API 地址设置有效的 API Key。');
  const control = new AbortController();
  let timedOut = false,
    idleTimedOut = false,
    text = '',
    bytes = 0,
    reasoning = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, phase: RequestPhase | undefined;
  const started = Date.now(),
    elapsed = () => Date.now() - started;
  const stats: DiagnosticCounters = {
    outcome: 'error',
    httpStatus: null,
    firstByteMs: null,
    firstContentMs: null,
    lastByteMs: null,
    lastContentMs: null,
    events: 0,
    contentEvents: 0,
    reasoningEvents: 0,
    heartbeatEvents: 0,
    unknownEvents: 0,
    finishReason: null,
    doneSeen: false
  };
  const cancel = () => control.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, timeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      cancel();
    }, idleTimeoutMs);
  };
  const progress = (value: RequestPhase) => {
    if (phase !== value) {
      phase = value;
      onProgress(value);
    }
  };
  const append = (value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    text += value;
    stats.firstContentMs ??= elapsed();
    stats.lastContentMs = elapsed();
    stats.contentEvents++;
    if (text.length > 64000) throw new Error('AI 回复过长，已停止接收。');
    progress('answering');
    onDelta(value);
  };
  const checkFinish = (reason: unknown) => {
    if (reason === 'length')
      throw new Error(
        text.trim()
          ? 'AI 回复达到长度上限，内容尚未完整；可输入“继续”补全，或缩小问题范围后重新分析。'
          : 'AI 已达到生成长度上限，但尚未返回正文；推理可能已耗尽额度，请改用较快的模型或缩小问题范围。'
      );
    if (reason === 'content_filter') throw new Error('AI 服务未完成此次回答，请调整问题后重试。');
    if (reason === 'tool_calls' || reason === 'function_call')
      throw new Error('AI 返回了工具调用，当前分析需要文本回复；请更换文本对话模型。');
  };
  try {
    activity();
    progress('connecting');
    const response = await fetch(address, {
      method: 'POST',
      redirect: 'manual',
      signal: control.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        Authorization: 'Bearer ' + key.trim()
      },
      body: JSON.stringify(requestBody(address, name, messages, maxTokens))
    });
    stats.httpStatus = response.status;
    stats.headersMs = elapsed();
    if (!response.ok) {
      stats.outcome = 'http_error';
      await response.body?.cancel();
      throw httpError(response.status);
    }
    if (!response.body) throw new Error('AI 接口返回了空响应。');
    activity();
    progress('waiting');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stream = (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
    let buffer = '',
      done = false,
      finished = false;
    const event = (frame: string) => {
      const payload = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!payload) {
        stats.heartbeatEvents++;
        return;
      }
      stats.events++;
      if (payload === '[DONE]') {
        stats.doneSeen = true;
        done = true;
        return;
      }
      let item;
      try {
        item = JSON.parse(payload);
      } catch {
        throw new Error('AI 流式响应格式不正确，请确认接口兼容 Chat Completions。');
      }
      if (item.error) throw new Error('AI 服务返回错误，请检查模型、权限或余额。');
      if (typeof item.type === 'string' && item.type.startsWith('response.'))
        throw new Error('AI 接口返回了 Responses 格式；请填写兼容 Chat Completions 的接口地址。');
      const choice = item.choices?.[0];
      if (choice?.finish_reason)
        stats.finishReason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(
          choice.finish_reason
        )
          ? choice.finish_reason
          : 'other';
      if (item.usage)
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
          if (Number.isFinite(item.usage[key])) (stats.usage ||= {})[key] = item.usage[key];
        }
      if (
        !choice?.delta?.content &&
        !choice?.delta?.reasoning_content &&
        !choice?.delta?.reasoning &&
        !choice?.finish_reason &&
        !choice?.delta?.role &&
        !item.usage
      )
        stats.unknownEvents++;
      if (choice?.delta?.reasoning_content || choice?.delta?.reasoning) {
        stats.reasoningEvents++;
        reasoning = true;
        activity();
        if (!text) progress('reasoning');
      }
      if (choice?.delta?.content) activity();
      append(choice?.delta?.content);
      checkFinish(choice?.finish_reason);
      if (choice?.finish_reason) {
        finished = true;
        done = true;
      }
    };
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stats.firstByteMs ??= elapsed();
      stats.lastByteMs = elapsed();
      bytes += chunk.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('AI 响应超过大小限制，已停止接收。');
      buffer += decoder.decode(chunk.value, { stream: true });
      // Some compatible gateways omit or mislabel the SSE content type.
      if (!stream && /^(?:data:|event:|:)/.test(buffer.trimStart())) stream = true;
      if (stream) {
        // Normalize CRLF after appending so separators split across chunks survive.
        buffer = buffer.replace(/\r\n/g, '\n');
        let separator;
        while (!done && (separator = buffer.indexOf('\n\n')) >= 0) {
          event(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
        }
      }
    }
    buffer += decoder.decode();
    if (stream) {
      if (!done && buffer.trim()) event(buffer.replace(/\r\n/g, '\n'));
      if (!done && !finished) {
        stats.outcome = 'stream_ended_without_finish';
        throw new Error(
          text.trim()
            ? 'AI 响应中断，回复尚未完整；已保留收到的内容，可继续追问或重新分析。'
            : 'AI 响应中断，尚未收到正文；请重新分析。'
        );
      }
    } else {
      let item;
      try {
        item = JSON.parse(buffer);
      } catch {
        throw new Error('AI 接口返回了非 JSON 内容，请检查 API 地址。');
      }
      if (item.error) throw new Error('AI 服务返回错误，请检查模型、权限或余额。');
      reasoning = Boolean(item.choices?.[0]?.message?.reasoning_content || item.choices?.[0]?.message?.reasoning);
      append(item.choices?.[0]?.message?.content);
      const reason = item.choices?.[0]?.finish_reason;
      if (reason)
        stats.finishReason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(reason)
          ? reason
          : 'other';
      checkFinish(item.choices?.[0]?.finish_reason);
    }
    if (!text.trim())
      throw new Error(
        reasoning
          ? 'AI 只返回了推理过程，没有分析正文；请重试或更换模型。'
          : 'AI 未返回分析内容；请检查模型是否支持文本对话。'
      );
    stats.outcome = 'complete';
    return text;
  } catch (error) {
    if (signal?.aborted) stats.outcome = 'cancelled';
    else if (timedOut) stats.outcome = 'total_timeout';
    else if (idleTimedOut) stats.outcome = 'idle_timeout';
    else if (stats.finishReason === 'length') stats.outcome = 'length_limit';
    const code = error?.cause?.code || error?.code;
    if (
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
        'UND_ERR_SOCKET'
      ].includes(code)
    )
      stats.networkCode = code;
    if (signal?.aborted) {
      const e = new Error('已停止分析');
      e.name = 'AbortError';
      throw e;
    }
    if (timedOut)
      throw new Error(
        text.trim()
          ? `AI 请求超时（${Math.ceil(timeoutMs / 1000)} 秒），回复尚未完整；已保留收到的内容，可继续追问或重新分析。`
          : `AI 请求超时（${Math.ceil(timeoutMs / 1000)} 秒），尚未收到正文；可重试或更换较快的模型。`
      );
    if (idleTimedOut)
      throw new Error(
        text.trim()
          ? `AI 回复中途停了，连续 ${Math.ceil(idleTimeoutMs / 1000)} 秒没有新内容；已保留收到的内容，可继续追问或重新分析。`
          : `AI 接口连续 ${Math.ceil(idleTimeoutMs / 1000)} 秒未返回有效内容，尚未收到正文；请检查网络或稍后重试。`
      );
    if (/^(AI |请填写|请先|API 地址)/.test(error.message)) throw error;
    throw new Error(
      text.trim()
        ? 'AI 回复连接中断，回复尚未完整；已保留收到的内容，可继续追问或重新分析。'
        : '无法连接 AI 接口，请检查网络和 API 地址。'
    );
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', cancel);
    try {
      onDiagnostic({ ...stats, elapsedMs: elapsed(), bytes, contentChars: text.length, idleTimeoutMs, timeoutMs });
    } catch {
      /* Diagnostics never affect the request. */
    }
    // Completion must not wait for a gateway to acknowledge stream cancellation.
    if (reader) void reader.cancel().catch(() => {});
  }
}
function diagnosticText(d: AiDiagnostic | undefined): string {
  if (!d) return '尚无请求记录。';
  const seconds = (value: number | null | undefined) =>
    Number.isFinite(value) ? `${(value! / 1000).toFixed(2)} 秒` : '未收到';
  const outcomes = {
    complete: '正常完成',
    cancelled: '已手动停止',
    idle_timeout: '等待新内容超时',
    total_timeout: '达到请求总时限',
    http_error: '接口返回错误',
    stream_ended_without_finish: '连接结束但未收到完成标记',
    length_limit: '达到回复长度上限',
    error: '请求未正常完成'
  };
  const lines = [
    `结果：${outcomes[d.outcome] || '请求未正常完成'}`,
    `记录时间：${d.at ? new Date(d.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + ' 北京' : '—'}`,
    `接口状态：${d.httpStatus || '未收到 HTTP 响应'}；总耗时：${seconds(d.elapsedMs)}`,
    `首次正文：${seconds(d.firstContentMs)}；已收到正文：${d.contentChars || 0} 字符 / ${d.contentEvents || 0} 段`,
    `最后网络数据：请求开始后 ${seconds(d.lastByteMs)}；最后正文：${seconds(d.lastContentMs)}`,
    `结束标记：${d.finishReason || (d.doneSeen ? '[DONE]' : '未收到')}；心跳：${d.heartbeatEvents || 0} 次；未识别事件：${d.unknownEvents || 0} 次`
  ];
  if (d.networkCode) lines.push(`网络错误：${d.networkCode}`);
  if (d.outcome === 'idle_timeout') {
    const stillReceiving = Number.isFinite(d.lastByteMs) && d.elapsedMs - d.lastByteMs! < d.idleTimeoutMs / 2;
    lines.push(
      stillReceiving
        ? '判断：连接仍有数据，但没有新的可识别内容。请检查服务端生成进度或兼容接口的返回格式。'
        : '判断：后续网络数据和正常结束标记均未到达。仅凭客户端记录不能区分服务端停顿、网关或网络中断。'
    );
    if (d.contentChars) lines.push('已保留部分分析，可发送“继续”补全。');
  } else if (d.outcome === 'total_timeout')
    lines.push('判断：达到插件的总等待时限；若最后正文接近结束时间，说明内容仍在生成。可发送“继续”补全。');
  return lines.join('\n');
}
export { endpoint, modelName, secretId, complete, requestBody, diagnosticText };
