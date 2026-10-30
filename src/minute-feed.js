'use strict';
const { requestJson } = require('./http');
const { normalizeSymbol } = require('./quotes');
const HOSTS = ['web.ifzq.gtimg.cn', 'ifzq.gtimg.cn'];
const WAF_COOLDOWN = 5 * 60 * 1000, FAILURE_COOLDOWN = 30000;

// Both Tencent hosts expose the same public minute JSON schema. Never execute
// a WAF response or copy browser credentials to retrieve chart data.
class MinuteFeed {
  constructor(request = requestJson, now = () => Date.now()) {
    this.request = request; this.now = now; this.failures = new Map();
  }
  async load(input, signal) {
    return this.loadPath(input, signal, 'minute');
  }
  async loadHistory(input, signal) {
    return this.loadPath(input, signal, 'day');
  }
  async loadPath(input, signal, path) {
    const symbol = normalizeSymbol(input), errors = [];
    for (const [index, host] of HOSTS.entries()) {
      if (signal?.aborted) throw new Error('行情请求已取消');
      const key = `${path}:${host}`;
      const failure = this.failures.get(key);
      if (failure && this.now() < failure.until) { errors.push(failure.message); continue; }
      try {
        const payload = await this.request(`https://${host}/appstock/app/${path}/query?code=${symbol}`, signal);
        if (signal?.aborted) throw new Error('行情请求已取消');
        this.failures.delete(key);
        return { payload, backup: index > 0 };
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') throw error;
        const waf = error.statusCode === 501 || /HTTP 501\b/.test(error.message || '');
        const message = error.message || '网络连接失败';
        this.failures.set(key, { until: this.now() + (waf ? WAF_COOLDOWN : FAILURE_COOLDOWN), message });
        errors.push(message);
      }
    }
    throw new Error(`腾讯分时暂不可用（主接口：${errors[0]}；备用接口：${errors[1]}），请稍后重试`);
  }
}
module.exports = { MinuteFeed, HOSTS, WAF_COOLDOWN, FAILURE_COOLDOWN };
