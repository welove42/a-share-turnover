'use strict';
const https = require('node:https');

function requestBuffer(url, signal, headers = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const request = https.get(url, {
      signal,
      headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'A-Share-Turnover-VSCode/1.1', Accept: '*/*', ...headers }
    }, response => {
      if (response.statusCode !== 200) {
        response.resume(); finish(new Error(`数据接口 HTTP ${response.statusCode}`)); return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(new Error('数据响应超过大小限制'));
        else chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('end', () => finish(null, Buffer.concat(chunks)));
    });
    request.on('error', error => finish(error));
    timer = setTimeout(() => request.destroy(new Error('数据请求超时（8秒）')), 8000);
  });
}

async function requestJson(url, signal, headers) {
  const buffer = await requestBuffer(url, signal, headers);
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('数据接口返回了非 JSON 内容'); }
}
async function requestQuoteText(url, signal) {
  return new TextDecoder('gb18030').decode(await requestBuffer(url, signal));
}
module.exports = { requestBuffer, requestJson, requestQuoteText };
