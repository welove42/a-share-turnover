import { usClock } from '../watchlist/overseas/extended-session';

const MARKETS = {
  us: { name: '美国', zone: 'America/New_York', ids: ['100.NDX', '100.NDX100', '100.SPX', '100.DJIA'] },
  jp: { name: '日本', zone: 'Asia/Tokyo', ids: ['100.N225'] },
  kr: { name: '韩国', zone: 'Asia/Seoul', ids: ['100.KS11', '100.KOSPI200'] }
} as const;
const local = (time: Date, timeZone: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short'
    })
      .formatToParts(time)
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
    weekday: !['Sat', 'Sun'].includes(p.weekday)
  };
};
/** 仅标注常规时段，不能据此断言节假日已开市。纽约时区由 Intl 处理夏令时。 */
export function regionalSessions(now: Date) {
  return Object.entries(MARKETS).map(([id, market]) => {
    const clock = local(now, market.zone);
    // JPX 09:00–11:30 / 12:30–15:30；KRX 09:00–15:30（特殊日期以交易所安排为准）。
    const phase =
      id === 'us'
        ? usClock(now).phase
        : !clock.weekday
          ? 'closed'
          : clock.minute < 540
            ? 'pre'
            : clock.minute >= 930
              ? 'closed'
              : id === 'jp' && clock.minute >= 690 && clock.minute < 750
                ? 'break'
                : 'regular';
    return {
      id,
      name: market.name,
      timeZone: market.zone,
      date: clock.date,
      time: clock.time,
      phase,
      label: { pre: '盘前', regular: '常规交易时段', post: '盘后', break: '午休', closed: '常规时段外' }[phase],
      basis: '按当地常规时段估算，未据此确认节假日或临时休市；以报价时间为准'
    };
  });
}

export function cashTiming(id: string, timestamp: number, now: Date, timestampKind?: string) {
  const market = Object.entries(MARKETS).find(([, v]) => (v.ids as readonly string[]).includes(id));
  if (!market) return {};
  const session = regionalSessions(now).find((s) => s.id === market[0])!;
  const quote = local(new Date(timestamp * 1000), market[1].zone);
  const age = now.getTime() - timestamp * 1000;
  const current =
    session.phase === 'regular' &&
    quote.date === session.date &&
    age >= 0 &&
    age <= 5 * 60000 &&
    timestampKind !== 'updated';
  return {
    market: session.name,
    quoteLocalTime: `${quote.date} ${quote.time}`,
    quoteTimeZone: session.timeZone,
    currentReference: current,
    usage: current
      ? '当前常规时段报价参考'
      : timestampKind === 'updated'
        ? '来源更新时间，无法确认逐笔报价时效'
        : session.phase === 'regular'
          ? '较早报价，仅作背景，不代表当前盘中'
          : '最近常规时段报价，仅作收盘背景，不代表当前盘前/盘后走势'
  };
}

export function futureTiming(timestamp: number, now: Date, fetchFailed: boolean) {
  const age = now.getTime() - timestamp * 1000;
  return {
    currentReference: !fetchFailed && age >= 0 && age <= 5 * 60000,
    usage: fetchFailed
      ? '本次获取失败，缓存报价仅作背景'
      : age < 0
        ? '来源时间晚于本机，暂不能确认时效'
        : age > 5 * 60000
          ? '较早期货参考报价，不代表当前走势'
          : '近期盘外情绪参考，不等于现货指数或个股盘前涨跌'
  };
}
