'use strict';
function normalizeOverseas(value, market) {
  if (typeof value !== 'string') throw new Error('请输入股票代码');
  const input = value.trim();
  if (market === 'hk') {
    const match = input.match(/^(?:hk)?(\d{1,5})(?:\.hk)?$/i);
    if (match) return 'hk' + match[1].padStart(5, '0');
    throw new Error('港股代码示例：00700 或 hk00700');
  }
  if (market === 'us') {
    const clean = input.replace(/^us(?=[A-Z])/, '').replace(/\.(?:OQ|N|AM|PS)$/i, '').toUpperCase();
    if (/^[A-Z][A-Z0-9]{0,9}(?:\.[A-Z]{1,3})?$/.test(clean)) return 'us' + clean;
    throw new Error('美股代码示例：AAPL 或 usAAPL');
  }
  throw new Error('未知股票市场');
}
module.exports = { normalizeOverseas };
