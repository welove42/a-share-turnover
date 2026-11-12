const test = require('node:test');
const assert = require('node:assert/strict');
const { selectSectorHeatmapRows } = require('../dist/shared/sector-heatmap');

test('云图限制50条且输入不被重排，非有限和零权重不会破坏面积计算', () => {
  const rows = Array.from({ length: 65 }, (_, i) => ({ code: `BK${1000 + i}`, percent: i + 1, amount: 65 - i }));
  rows.push(
    { code: 'invalid', percent: NaN, amount: Infinity },
    { code: 'zero', percent: 0, amount: 0 },
    { code: 'missing', percent: Infinity, amount: null }
  );
  const original = rows.slice();
  const gainers = selectSectorHeatmapRows(rows, 'gainers');
  const amounts = selectSectorHeatmapRows(rows, 'amount');
  assert.equal(gainers.length, 50);
  assert.equal(amounts.length, 50);
  assert.equal(gainers[0].percent, 65);
  assert.equal(gainers.at(-1).percent, 16);
  assert.equal(amounts[0].amount, 65);
  assert.deepEqual(selectSectorHeatmapRows(rows, 'losers'), []);
  assert.deepEqual(rows, original);
  const tied = [
    { code: 'b', percent: -2, amount: 100 },
    { code: 'a', percent: -2, amount: 100 }
  ];
  assert.deepEqual(selectSectorHeatmapRows(tied, 'losers').map((row) => row.code), ['a', 'b']);
});
