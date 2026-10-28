'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { ChartProvider, parseChart } = require('../src/chart-data');
const { marketRisk } = require('../src/risk');
test('分钟K线真实开高低收、跨日顺序、成交量和结束时间', async () => {
  for (const mode of ['m1', 'm5', 'm15', 'm30', 'm60']) {
    const payload = { code: 0, data: { sh600105: { [mode]: [['202610271500','10','11','12','9','100'], ['202610280935','11','10','12','9','55']] } } };
    const provider = new ChartProvider(async url => { assert.match(url, new RegExp(`,${mode},,240$`)); return payload; });
    const result = await provider.load('sh600105', mode);
    assert.equal(result.bars[1].time, '2026-10-28 09:35'); assert.equal(result.bars[1].volume, 55); assert.equal(result.adjustment, '不复权');
    payload.data.sh600105[mode].reverse(); assert.throws(() => parseChart(payload, 'sh600105', mode), /顺序/);
  }
});
test('风险仅在同日新鲜且同刻数据达到阈值时显示，暂停、错误和跨时刻不误报', () => {
  const now = new Date('2026-10-28T10:30:00+08:00');
  const snapshot = { date:'2026-10-28', fetchedAt:now.toISOString(), comparisonTime:'10:30', sameTime:{ percent:35 } };
  const quote = { date:'2026-10-28', timestamp:'20261028103000', percent:-2 };
  const clock = { date:'2026-10-28', phase:'trading', polling:true };
  const risk = (s=snapshot, state={}, q=quote, opts={}) => marketRisk(s,state,q,clock,now,opts);
  assert.equal(risk().label, '放量下跌');
  assert.equal(risk({...snapshot,sameTime:{percent:-35}}).label, '缩量下跌');
  assert.equal(risk(snapshot,{paused:true}), null); assert.equal(risk(snapshot,{error:'断网'}), null);
  assert.equal(risk(snapshot,{}, {...quote,stale:true}), null); assert.equal(risk(snapshot,{}, {...quote,timestamp:'20261028102500'}), null);
  assert.equal(risk(snapshot,{}, {...quote,timestamp:'20261028259900'}), null);
  assert.equal(risk(snapshot,{}, {...quote,percent:-1}), null); assert.equal(risk(snapshot,{},quote,{enabled:false}), null);
  assert.equal(risk({...snapshot,date:'2026-10-27'}), null);
  assert.equal(risk({...snapshot,fetchedAt:'2026-10-28T02:27:00.000Z'}), null);
});
