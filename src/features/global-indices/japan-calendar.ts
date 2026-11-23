/** JPX 官方现货休市日快照；仅覆盖已核实的2026、2027年，交易所临时调整仍以公告为准。
 * https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html
 * 此日历不适用于日本期货、其他交易所或 CFD。
 */
const HOLIDAYS: Record<string, string> = {
  '2026-01-01': '元旦',
  '2026-01-02': '年初休市',
  '2026-01-03': '年初休市',
  '2026-01-12': '成人节',
  '2026-02-11': '建国纪念日',
  '2026-02-23': '天皇诞生日',
  '2026-03-20': '春分日',
  '2026-04-29': '昭和日',
  '2026-05-03': '宪法纪念日',
  '2026-05-04': '绿之日',
  '2026-05-05': '儿童节',
  '2026-05-06': '宪法纪念日补休',
  '2026-07-20': '海之日',
  '2026-08-11': '山之日',
  '2026-09-21': '敬老日',
  '2026-09-22': '国民假日',
  '2026-09-23': '秋分日',
  '2026-10-12': '体育日',
  '2026-11-03': '文化日',
  '2026-11-23': '勤劳感谢日',
  '2026-12-31': '年末休市',
  '2027-01-01': '元旦',
  '2027-01-02': '年初休市',
  '2027-01-03': '年初休市',
  '2027-01-11': '成人节',
  '2027-02-11': '建国纪念日',
  '2027-02-23': '天皇诞生日',
  '2027-03-21': '春分日',
  '2027-03-22': '春分日补休',
  '2027-04-29': '昭和日',
  '2027-05-03': '宪法纪念日',
  '2027-05-04': '绿之日',
  '2027-05-05': '儿童节',
  '2027-07-19': '海之日',
  '2027-08-11': '山之日',
  '2027-09-20': '敬老日',
  '2027-09-23': '秋分日',
  '2027-10-11': '体育日',
  '2027-11-03': '文化日',
  '2027-11-23': '勤劳感谢日',
  '2027-12-31': '年末休市'
};
const tokyoDate = (time: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(time);

export function japanCashDay(time: Date): { date: string; closed: boolean; reason?: string; covered: boolean } {
  const date = tokyoDate(time);
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  const reason = HOLIDAYS[date] || (weekday === 0 || weekday === 6 ? '周末' : undefined);
  return { date, closed: !!reason, reason, covered: date.startsWith('2026-') || date.startsWith('2027-') };
}

/** 休市日的源更新时间不能证实指数发生交易，也不能用它阻挡较早的有效收盘行情。 */
export function trustworthyJapanCashQuote(q: { id: string; timestamp: number }): boolean {
  return q.id !== '100.N225' || !japanCashDay(new Date(q.timestamp * 1000)).closed;
}
