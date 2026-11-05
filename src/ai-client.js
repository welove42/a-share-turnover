'use strict';
const { createHash } = require('node:crypto');

function endpoint(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请填写有效的 API 地址，例如 https://api.example.com/v1'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('API 地址必须使用 HTTPS；本机服务可使用 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含账号、密码、查询参数或锚点。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}
function secretId(url) { return 'ai.apiKey.' + createHash('sha256').update(endpoint(url)).digest('hex'); }
function modelName(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model || model.length > 160 || /[\r\n\x00-\x1f]/.test(model)) throw new Error('请填写服务商提供的模型名称（最多 160 字符）。');
  return model;
}
function httpError(status) {
  const hints = { 400: '请检查模型名称及接口是否兼容 Chat Completions', 401: 'API Key 无效或已过期，请重新设置', 403: '没有调用权限，请检查服务商授权', 404: '接口路径或模型不存在，请检查 API 地址和模型名称', 429: '请求受限或余额不足，请稍后重试或检查服务商账户' };
  return new Error(`AI 接口 HTTP ${status}：${hints[status] || '服务暂不可用，请稍后重试'}`);
}
// No redirects, provider error bodies or request headers enter the UI/logs.
async function complete({ url, model, key, messages, signal, onDelta = () => {}, timeoutMs = 90000, maxTokens = 2200 }) {
  const address = endpoint(url), name = modelName(model);
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('请先为当前 API 地址设置有效的 API Key。');
  const control = new AbortController();
  let timedOut = false, reader, text = '', bytes = 0;
  const cancel = () => control.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  const append = value => {
    if (typeof value !== 'string' || !value) return;
    text += value;
    if (text.length > 64000) throw new Error('AI 回复过长，已停止接收。');
    onDelta(value);
  };
  const checkFinish = reason => {
    if (reason === 'length') throw new Error('AI 回复达到长度上限，内容尚未完整；请缩小问题范围后重试。');
    if (reason === 'content_filter') throw new Error('AI 服务未完成此次回答，请调整问题后重试。');
  };
  try {
    const response = await fetch(address, { method: 'POST', redirect: 'manual', signal: control.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', Authorization: 'Bearer ' + key.trim() },
      body: JSON.stringify({ model: name, messages, stream: true, max_tokens: maxTokens }) });
    if (!response.ok) { await response.body?.cancel(); throw httpError(response.status); }
    if (!response.body) throw new Error('AI 接口返回了空响应。');
    reader = response.body.getReader();
    const decoder = new TextDecoder(), stream = (response.headers.get('content-type') || '').includes('text/event-stream');
    let buffer = '', done = false, finished = false;
    const event = frame => {
      const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
      if (!payload) return;
      if (payload === '[DONE]') { done = true; return; }
      let item;
      try { item = JSON.parse(payload); } catch { throw new Error('AI 流式响应格式不正确，请确认接口兼容 Chat Completions。'); }
      if (item.error) throw new Error('AI 服务返回错误，请检查模型、权限或余额。');
      const choice = item.choices?.[0];
      if (choice?.finish_reason) finished = true;
      append(choice?.delta?.content);
      checkFinish(choice?.finish_reason);
    };
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('AI 响应超过大小限制，已停止接收。');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (stream) {
        // Normalize CRLF after appending so separators split across chunks survive.
        buffer = buffer.replace(/\r\n/g, '\n');
        let separator;
        while (!done && (separator = buffer.indexOf('\n\n')) >= 0) { event(buffer.slice(0, separator)); buffer = buffer.slice(separator + 2); }
      }
    }
    buffer += decoder.decode();
    if (stream) {
      if (!done && buffer.trim()) event(buffer.replace(/\r\n/g, '\n'));
      if (!done && !finished) throw new Error('AI 响应中断；当前内容不完整，可重新分析。');
    } else {
      let item;
      try { item = JSON.parse(buffer); } catch { throw new Error('AI 接口返回了非 JSON 内容，请检查 API 地址。'); }
      if (item.error) throw new Error('AI 服务返回错误，请检查模型、权限或余额。');
      append(item.choices?.[0]?.message?.content);
      checkFinish(item.choices?.[0]?.finish_reason);
    }
    if (!text.trim()) throw new Error('AI 未返回分析内容；请检查模型是否支持文本对话。');
    return text;
  } catch (error) {
    if (timedOut) throw new Error('AI 请求超时（90 秒），可稍后重试或更换模型。');
    if (signal?.aborted) { const e = new Error('已停止分析'); e.name = 'AbortError'; throw e; }
    if (/^(AI |请填写|请先|API 地址)/.test(error.message)) throw error;
    throw new Error('无法连接 AI 接口，请检查网络和 API 地址。');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (reader) await reader.cancel().catch(() => {});
  }
}
module.exports = { endpoint, modelName, secretId, complete };
