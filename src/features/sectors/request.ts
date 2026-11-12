export async function withSectorDeadline<T>(
  signal: AbortSignal,
  timeoutMs: number,
  read: (signal: AbortSignal) => Promise<T>,
  message: string
): Promise<T> {
  if (signal.aborted) throw new Error('请求已取消');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let cancel: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      reject(new Error('请求已取消'));
      controller.abort();
    };
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(
      () => {
        reject(new Error(message));
        controller.abort();
      },
      Math.max(1, timeoutMs)
    );
  });
  try {
    return await Promise.race([read(controller.signal), deadline]);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', cancel!);
  }
}
