import { endpoint, modelName } from './client';
class ModelListError extends Error {}

/** 与已配置的 Chat Completions 同一前缀，不猜测其他主机或转发 Key。 */
export function modelsEndpoint(value: unknown): string {
  const url = new URL(endpoint(value));
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses)$/, '/models');
  return url.href;
}

export function parseModelIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ModelListError('服务商返回的模型列表格式不兼容，请手动输入模型 ID。');
  const ids = new Set<string>();
  for (const item of data.slice(0, 5000)) {
    try {
      ids.add(modelName(item?.id));
    } catch {
      /* Ignore malformed entries, never stringify objects. */
    }
    if (ids.size >= 2000) break;
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export async function listModels({
  url,
  key,
  signal,
  timeoutMs = 15000,
  request = fetch
}: {
  url: string;
  key: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  request?: typeof fetch;
}): Promise<string[]> {
  const address = modelsEndpoint(url);
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key))
    throw new Error('请先填写当前 API 地址的 Key；已保存时可留空。');
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    cancel();
  }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (signal?.aborted) throw new Error('cancelled');
    const response = await request(address, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: abort.signal
    });
    if (abort.signal.aborted) throw new Error('cancelled');
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const hints: Record<number, string> = {
        401: 'API Key 无效或已过期',
        403: 'Key 没有查询模型列表的权限',
        404: '服务商不支持此模型列表接口，可手动输入模型 ID',
        405: '服务商不支持获取模型列表，可手动输入模型 ID',
        429: '请求过于频繁，请稍后重试'
      };
      throw new ModelListError(
        `模型列表 HTTP ${response.status}：${
          response.status >= 300 && response.status < 400
            ? '接口发生重定向，请填写最终 API 地址后重试'
            : hints[response.status] || '服务暂不可用，请稍后重试'
        }`
      );
    }
    if (!response.body) throw new ModelListError('模型列表响应为空，请手动输入模型 ID。');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new ModelListError('模型列表响应过大，请手动输入模型 ID。');
      chunks.push(chunk.value);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ModelListError('服务商未返回有效的模型列表，请检查 API 地址或手动输入模型 ID。');
    }
    if (abort.signal.aborted) throw new Error('cancelled');
    return parseModelIds(payload).filter((id) => key.trim().length < 12 || !id.includes(key.trim()));
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('获取模型列表已取消。'), { name: 'AbortError' });
    if (expired) throw new Error('获取模型列表超时（15秒），可重试或手动输入模型 ID。');
    // Only our fixed messages reach the UI; never include provider bodies, URLs or headers.
    if (error instanceof ModelListError) throw error;
    throw new Error('模型列表连接失败，请检查 API 地址和网络后重试。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    void reader?.cancel().catch(() => {});
  }
}
