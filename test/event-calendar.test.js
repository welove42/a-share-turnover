'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { zonedTime, beijing, staticEvents, parseFed, parseBls } = require('../src/event-calendar');
const { harness } = require('./vscode-mock');

test('美国夏令时和冬令时转换为北京时间', () => {
  assert.equal(beijing(zonedTime('2026-10-30','08:30','America/New_York')), '2026-10-30 20:30');
  assert.equal(beijing(zonedTime('2026-11-06','08:30','America/New_York')), '2026-11-06 21:30');
  assert.equal(beijing(zonedTime('2026-12-09','14:00','America/New_York')), '2026-12-10 03:00');
  assert.throws(() => zonedTime('2026-02-30','08:30','America/New_York'));
  assert.throws(() => zonedTime('2026-03-08','02:30','America/New_York'));
});
test('休市和股指交割严格限于已核实的年度，半日市独立标记', () => {
  const entries = staticEvents(['2026-11-20']);
  assert.ok(entries.some(e => e.type === 'delivery' && e.date === '2026-11-23'));
  assert.equal(entries.filter(e => e.type === 'delivery').length,12);
  assert.ok(entries.filter(e => e.type === 'delivery').every(e => e.date.startsWith('2026')));
  assert.ok(entries.some(e => e.name === '港股半日市·圣诞节前夕'));
  assert.ok(entries.some(e => e.name === '美股提前收盘·感恩节翌日' && beijing(e.when) === '2026-11-28 02:00'));
  assert.ok(entries.some(e => e.type === 'cnHoliday' && /复市 2026-10-09/.test(e.detail)) === false);
});
test('官方非农表格解析并拒绝字段异常', () => {
  const rows = [['October 2026','Nov. 06, 2026'],['November 2026','Dec. 04, 2026'],['December 2026','Jan. 08, 2027']];
  const html = rows.map(([period,date]) => `<tr><td>${period}</td><td>${date}</td><td>08:30 AM</td></tr>`).join('');
  const events = parseBls(html,'nonfarm');
  assert.equal(events.length,3); assert.equal(beijing(events[0].when),'2026-11-06 21:30');
  assert.throws(() => parseBls(html.replace('08:30 AM','invalid'),'nonfarm'));
});
test('美联储跨月会议取最后一天，忽略非议息投票和历史年份', () => {
  const rows = ['January|27-28','March|17-18*','Apr/May|30-1','June|16-17*','July|28-29','September|15-16*','October|27-28','December|8-9*','August|22 (notation vote)'];
  const html = '<a>2026 FOMC Meetings</a>' + rows.map(row => {
    const [month,date] = row.split('|');
    return `<div class="fomc-meeting__month"><strong>${month}</strong></div><div class="fomc-meeting__date">${date}</div>`;
  }).join('');
  const result = parseFed(html); assert.equal(result.length,8); assert.equal(result[2].date,'2026-05-01');
});
test('提醒一次去重，重新启动后保留，并在临近时再次提醒', () => {
  const h = harness({ 'aShareTurnover.reminders.categories':['nonfarm'] });
  const messages = []; h.api.window.showInformationMessage = text => { messages.push(text); return Promise.resolve(); };
  const { ReminderController } = h.load('../src/reminders');
  let now = new Date('2026-11-05T14:00:00Z');
  const c = new ReminderController(h.context,{ now:() => now });
  c.render(); const writes = c.item.writes.text; c.render(); assert.equal(c.item.writes.text,writes);
  c.notifyDue(); c.notifyDue(); assert.equal(messages.length,1); assert.match(messages[0],/未在线核实/);
  const d = new ReminderController(h.context,{ now:() => now }); d.notifyDue(); assert.equal(messages.length,1);
  now = new Date('2026-11-06T13:10:00Z'); d.notifyDue(); d.notifyDue(); assert.equal(messages.length,2); assert.match(messages[1],/不足30分钟/);
  c.dispose(); d.dispose();
});
test('启动时已进入30分钟窗口不补发24小时提醒', () => {
  const h = harness({ 'aShareTurnover.reminders.categories':['nonfarm'] }); const messages=[];
  h.api.window.showInformationMessage = text => { messages.push(text); return Promise.resolve(); };
  const { ReminderController } = h.load('../src/reminders');
  const c = new ReminderController(h.context,{ now:() => new Date('2026-11-06T13:10:00Z') });
  c.notifyDue(); assert.equal(messages.length,1); assert.match(messages[0],/不足30分钟/); c.dispose();
});
