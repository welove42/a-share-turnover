import type { CalendarEvent } from './calendar';
import { beijing } from './calendar';

/** 休市按交易所当地日期展示，定时事件按北京时间归入日历。 */
export function calendarViewEvent(event: CalendarEvent) {
  const startDate = event.allDay ? event.date : beijing(event.when).slice(0, 10);
  const endDate = event.allDay && event.end
    ? new Intl.DateTimeFormat('sv-SE', { timeZone: event.zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(event.end - 1))
    : startDate;
  return {
    id: event.id, type: event.type, name: event.name, startDate,
    endDate: endDate >= startDate ? endDate : startDate,
    time: event.allDay ? '休市安排（当地日期）' : `${beijing(event.when)} 北京时间`,
    detail: event.detail, provenance: event.provenance || '来源信息暂缺',
    hasSource: /^https?:\/\//i.test(event.source || ''), cancelled: !!event.cancelled
  };
}
