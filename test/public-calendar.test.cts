const test = require('node:test'),
  assert = require('node:assert/strict');
const { parseWeekly, parseNyseEarly, WEEKLY_URL, NYSE_URL } = require('../dist/features/reminders/public-calendar.js');
const { beijing, DAY } = require('../dist/features/reminders/calendar.js');
const { OnlineCalendar } = require('../dist/features/reminders/online-calendar.js');
const { HttpError } = require('../dist/core/network/http.js');
const { harness } = require('./vscode-mock.cts');
const weekly = (date = '2026-11-10T08:30:00-05:00') =>
  JSON.stringify([
    { title: 'CPI m/m', country: 'USD', date },
    { title: 'CPI y/y', country: 'USD', date },
    { title: 'Core CPI m/m', country: 'USD', date },
    { title: 'FOMC Member Waller Speaks', country: 'USD', date },
    { title: 'CPI m/m', country: 'CAD', date }
  ]);
const nyse = `<h4>All NYSE markets observe U.S. holidays as listed below for 2026, 2027, and 2028.</h4>
<p><span>Each market will close early at 1:00 p.m. (1:15 p.m. for eligible options) on Friday, November 27, 2026, Friday, November 26, 2027, and Friday, November 24, 2028 (the day after Thanksgiving). All times are Eastern Time.</span></p>
<p>Each market will close early at 1:00 p.m. (1:15 p.m. for eligible options) on Thursday, December 24, 2026. All times are Eastern Time.</p>`;
const fed =
  '<a>2026 FOMC Meetings</a>' +
  [
    'January|27-28',
    'March|17-18*',
    'April|28-29',
    'June|16-17*',
    'July|28-29',
    'September|15-16*',
    'October|27-28',
    'December|8-9*'
  ]
    .map((row) => {
      const [month, date] = row.split('|');
      return `<div class="fomc-meeting__month"><strong>${month}</strong></div><div class="fomc-meeting__date">${date}</div>`;
    })
    .join('');

test('免费周日历去重并过滤核心CPI、讲话、其他国家，按真实时区换算', () => {
  const result = parseWeekly(weekly());
  assert.equal(result.events.length, 1);
  assert.equal(beijing(result.events[0].when), '2026-11-10 21:30');
  assert.equal(beijing(parseWeekly(weekly('2026-10-14T08:30:00-04:00')).events[0].when), '2026-10-14 20:30');
  assert.throws(() => parseWeekly(weekly('2026-11-10T08:30:00')), /时区/);
  assert.throws(() => parseWeekly(weekly('2026-02-30T08:30:00-05:00')), /日期/);
  assert.throws(() => parseWeekly('{}'));
  const conflicting = JSON.parse(weekly());
  conflicting[1].date = '2026-11-10T09:30:00-05:00';
  assert.throws(() => parseWeekly(JSON.stringify(conflicting)), /冲突/);
  assert.deepEqual(
    parseWeekly(JSON.stringify([{ title: 'ADP Employment Change', country: 'USD', date: '2026-11-10T08:30:00-05:00' }]))
      .events,
    []
  );
});

test('周日历识别非农与议息并合并重复利率声明，不把前瞻或会议纪要当议息', () => {
  const rows = ['Non-Farm Employment Change', 'FOMC Statement', 'Federal Funds Rate', 'FOMC Meeting Minutes'].map(
    (title) => ({ title, country: 'USD', date: '2026-11-06T08:30:00-05:00' })
  );
  assert.deepEqual(
    parseWeekly(JSON.stringify(rows))
      .events.map((e) => e.type)
      .sort(),
    ['fed', 'nonfarm']
  );
});

test('NYSE 官方提前收盘按公告时间解析，忽略脚本副本并拒绝不完整页面', () => {
  const result = parseNyseEarly(nyse + '<script>' + nyse.replace('1:00', '2:00') + '</script>');
  assert.equal(result.events.length, 4);
  assert.equal(beijing(result.events[0].when), '2026-11-28 02:00');
  assert.deepEqual(result.years, ['2026', '2027', '2028']);
  assert.throws(() => parseNyseEarly(nyse.replace(/1:00/g, '25:00')));
  assert.throws(() => parseNyseEarly('<h1>Access Denied</h1>'));
  assert.throws(() => parseNyseEarly(nyse.replace('2026, 2027, and 2028.', '2025.')));
});

function fixture() {
  const h = harness({ 'aShareTurnover.reminders.notifications': false }),
    calls = [];
  let time = Date.parse('2026-11-10T06:00:00Z'),
    failWeekly = false;
  const fetch = async (url) => {
    calls.push(url);
    assert.ok(!url.includes('financecalendar.com'), '不能调用失效的认证接口');
    if (url === WEEKLY_URL) {
      if (failWeekly) throw new HttpError(429);
      return weekly();
    }
    if (url === NYSE_URL) return nyse;
    if (url.includes('federalreserve.gov')) return fed;
    if (url.includes('bls.gov')) throw new HttpError(403);
    throw new Error('交易日历年份未覆盖或未经核实');
  };
  const { ReminderController } = h.load('../dist/features/reminders/controller.js');
  const create = () =>
    new ReminderController(h.context, {
      online: new OnlineCalendar(fetch),
      provider: { fetch },
      now: () => new Date(time)
    });
  return { h, calls, create, advance: (n) => (time += n), fail: () => (failWeekly = true) };
}

test('替换旧接口，官方与周日历覆盖旧缓存，状态栏不逐事件堆积HTTP错误', async () => {
  const f = fixture();
  await f.h.context.globalState.update('eventOnlineCache', {
    'economic:2026-11-01:2027-01-29': {
      at: Date.parse('2026-11-01T00:00:00Z'),
      text: JSON.stringify({
        from: '2026-11-01',
        to: '2027-01-29',
        count: 2,
        total: 2,
        events: [
          {
            series_code: 'us-cpi',
            date: '2026-11-11',
            release_at_utc: '2026-11-11T13:30:00Z',
            country: 'US',
            status: 'confirmed',
            data_stale: false,
            time_precision: 'minute'
          },
          {
            series_code: 'fomc',
            date: '2026-12-15',
            release_at_utc: '2026-12-15T19:00:00Z',
            country: 'US',
            status: 'confirmed',
            data_stale: false,
            time_precision: 'minute'
          }
        ]
      })
    }
  });
  const c = f.create();
  await c.refresh();
  const events = c.events();
  assert.ok(events.some((e) => e.type === 'cpi' && e.date === '2026-11-10' && /Forex Factory/.test(e.provenance)));
  assert.ok(events.some((e) => e.type === 'fed' && e.date === '2026-12-09' && /美联储官方/.test(e.provenance)));
  assert.ok(!events.some((e) => e.type === 'fed' && e.date === '2026-12-15'));
  assert.ok(events.some((e) => /提前收盘/.test(e.name) && /NYSE 官方/.test(e.provenance)));
  assert.doesNotMatch(c.item.tooltip, /HTTP|未更新（/);
  assert.match(c.item.tooltip, /更新 .*北京/);
  c.dispose();
});

test('重启、手动刷新和老板键恢复复用每日结果，403按来源冷却7天', async () => {
  const f = fixture(),
    c = f.create();
  await c.refresh();
  const count = f.calls.length;
  await c.refresh();
  await c.refresh(true);
  c.setHidden(true);
  c.setHidden(false);
  await c.refresh();
  assert.equal(f.calls.length, count);
  const restarted = f.create();
  await restarted.refresh(true);
  assert.equal(f.calls.length, count);
  f.advance(DAY);
  await restarted.refresh();
  assert.equal(f.calls.filter((u) => u.includes('bls.gov')).length, 2);
  assert.equal(f.calls.filter((u) => u === WEEKLY_URL).length, 2);
  f.advance(6 * DAY);
  await restarted.refresh();
  assert.equal(f.calls.filter((u) => u.includes('bls.gov')).length, 4);
  c.dispose();
  restarted.dispose();
});

test('失败保留原更新时间，6小时冷却期间不重试', async () => {
  const f = fixture(),
    c = f.create();
  await c.refresh();
  const first = c.records.get('weekly').at;
  f.advance(DAY);
  f.fail();
  await c.refresh();
  assert.equal(c.records.get('weekly').at, first);
  assert.equal(c.records.get('weekly').cached, true);
  const count = f.calls.length;
  await c.refresh(true);
  assert.equal(f.calls.length, count);
  f.advance(DAY / 4);
  await c.refresh();
  assert.equal(f.calls.filter((u) => u === WEEKLY_URL).length, 3);
  assert.equal(c.records.get('weekly').at, first);
  c.dispose();
});

test('格式异常的周日历不能覆盖上次成功缓存', async () => {
  const f = fixture(),
    c = f.create();
  await c.refresh();
  const first = c.records.get('weekly').at;
  c.online.fetch = async () => weekly('2026-11-10T08:30:00');
  f.advance(DAY);
  await c.refresh();
  assert.equal(c.records.get('weekly').at, first);
  assert.match(c.onlineErrors.get('weekly'), /时区/);
  c.dispose();
});

test('过期周日历和取消的请求不覆盖已有缓存或记录成功更新时间', async () => {
  const f = fixture(),
    c = f.create();
  await c.refresh();
  const first = c.records.get('weekly').at;
  f.advance(15 * DAY);
  await c.refresh();
  assert.equal(c.records.get('weekly').at, first);
  assert.match(c.onlineErrors.get('weekly'), /覆盖/);
  c.dispose();
  const h = harness();
  const { ReminderController } = h.load('../dist/features/reminders/controller.js');
  let controller;
  const fetch = async () => {
    controller.abort.abort();
    return weekly();
  };
  controller = new ReminderController(h.context, { online: new OnlineCalendar(fetch), provider: { fetch } });
  await controller.refresh();
  assert.equal(h.store.has('eventOnlineCache'), false);
  assert.equal(h.store.has('eventCalendarAttemptsV2'), false);
  controller.dispose();
});
