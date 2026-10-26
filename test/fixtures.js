'use strict';

const SYMBOLS = ['sh000002', 'sz399107'];
function quote(symbol, amount, stamp = '20261026103030') {
  const q = Array(90).fill('0');
  q[2] = symbol.slice(2);
  q[30] = stamp;
  q[35] = `3000/10000/${amount}`;
  q[37] = String(amount / 10000);
  return q;
}
function minutePayload(symbol, amount = 200e8, stamp = '20261026103030', rows) {
  return { code: 0, data: { [symbol]: {
    data: { date: stamp.slice(0, 8), data: rows || ['0930 3000 100 100000000', `1030 3000 1000 ${amount - 1e8}`] },
    qt: { [symbol]: quote(symbol, amount, stamp) }
  } } };
}
function historyPayload(symbol, rows) {
  return { code: 0, data: { [symbol]: { data: rows || [
    { date: '20261026', data: ['0930 3000 100 100000000'] },
    { date: '20261023', data: ['0930 3000 100 100000000', '1030 3000 1000 10000000000', '1500 3000 2000 30000000000'] },
    { date: '20261022', data: ['0930 3000 100 100000000', '1030 3000 1000 8000000000', '1500 3000 2000 28000000000'] }
  ] } } };
}
module.exports = { SYMBOLS, quote, minutePayload, historyPayload };
