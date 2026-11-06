import * as https from 'node:https';
import type { OutgoingHttpHeaders } from 'node:http';

/** 只向上层暴露状态码，不把外部响应正文混入错误提示。 */
export class HttpError extends Error {
  constructor(public readonly statusCode: number | undefined) {
    super(`数据接口 HTTP ${statusCode}`);
  }
}

function requestBuffer(url: string, signal?: AbortSignal, headers: OutgoingHttpHeaders = {}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error: Error | null, value?: Buffer) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const request = https.get(
      url,
      {
        signal,
        headers: {
          Referer: 'https://gu.qq.com/',
          'User-Agent': 'A-Share-Turnover-VSCode/1.1',
          Accept: '*/*',
          ...headers
        }
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          const error = new HttpError(response.statusCode);
          finish(error);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) request.destroy(new Error('数据响应超过大小限制'));
          else chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('end', () => finish(null, Buffer.concat(chunks)));
      }
    );
    request.on('error', (error) => finish(error));
    timer = setTimeout(() => request.destroy(new Error('数据请求超时（8秒）')), 8000);
  });
}

/** 泛型只描述接口格式；各业务解析器仍必须校验必填字段和数值。 */
async function requestJson<T = Record<string, any>>(
  url: string,
  signal?: AbortSignal,
  headers?: OutgoingHttpHeaders
): Promise<T> {
  const buffer = await requestBuffer(url, signal, headers);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('数据接口返回了非 JSON 内容');
  }
}
async function requestQuoteText(url: string, signal?: AbortSignal): Promise<string> {
  return new TextDecoder('gb18030').decode(await requestBuffer(url, signal));
}
export { requestBuffer, requestJson, requestQuoteText };
