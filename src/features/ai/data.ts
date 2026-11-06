function pick<T>(input: T, keys: readonly string[]): Partial<T> {
  const result: Record<string, string | number | boolean> = {};
  if (!input || typeof input !== 'object') return result as Partial<T>;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'string') result[key] = value.slice(0, 120);
  }
  return result as Partial<T>;
}
function abortError() {
  const error = new Error('已停止分析');
  error.name = 'AbortError';
  return error;
}
// Each background source has its own deadline; one failed source cannot stall AI.
type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };
async function attempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 16000
): Promise<Attempt<T>> {
  const control = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, cancel: (() => void) | undefined;
  try {
    const canceled = new Promise<never>((_, reject) => {
      cancel = () => {
        control.abort();
        reject(abortError());
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      timer = setTimeout(() => {
        control.abort();
        reject(new Error('数据源超时'));
      }, timeoutMs);
    });
    return {
      ok: true,
      value: await Promise.race([
        canceled,
        Promise.resolve().then(() => {
          if (control.signal.aborted) throw abortError();
          return operation(control.signal);
        })
      ])
    };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    return { ok: false, error: error.message || '数据不可用' };
  } finally {
    clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
    control.abort();
  }
}
function quoteTime(timestamp: number, now: number, kind = 'quote') {
  if (!Number.isFinite(timestamp) || timestamp < 946684800 || timestamp * 1000 > now + 300000)
    return { timeStatus: '时间缺失或异常' };
  return {
    timestamp,
    time: new Date(timestamp * 1000).toISOString(),
    timeKind: kind === 'updated' ? '来源更新时间，非逐笔行情时间' : '行情时间',
    ageMinutes: Math.max(0, Math.round((now - timestamp * 1000) / 60000)),
    historical: now - timestamp * 1000 > 5 * 86400000
  };
}
export { pick, attempt, abortError, quoteTime };
