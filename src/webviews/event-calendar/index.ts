export {};
interface EventItem {
  id: string; type: string; name: string; startDate: string; endDate: string;
  time: string; detail: string; provenance: string; hasSource: boolean; cancelled: boolean;
}
declare function acquireVsCodeApi(): { postMessage(value: unknown): void };
const vscode = acquireVsCodeApi();
const token = document.body.dataset.token;
const el = (id: string) => document.getElementById(id)!;
const post = (action: string, id?: string) => vscode.postMessage({ token, action, id });
let today = '', selected = '', year = 0, month = 0, items: EventItem[] = [];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const matching = (date: string) => items.filter((e) => e.startDate <= date && e.endDate >= date &&
  ((el('filter') as HTMLSelectElement).value === 'all' || e.type === (el('filter') as HTMLSelectElement).value));

function selectDate(date: string) {
  selected = date;
  year = Number(date.slice(0, 4)); month = Number(date.slice(5, 7)) - 1;
  render();
}
function render() {
  if (!today) return;
  (el('month') as HTMLInputElement).value = `${year}-${String(month + 1).padStart(2, '0')}`;
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 42; i++) {
    const date = new Date(Date.UTC(year, month, i - offset + 1));
    const key = iso(date), events = matching(key);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'day';
    button.classList.toggle('outside', date.getUTCMonth() !== month);
    button.classList.toggle('selected', key === selected);
    button.classList.toggle('today', key === today);
    button.setAttribute('aria-label', `${key}${key === today ? ' 今天' : ''}，${events.length} 个事件`);
    button.setAttribute('aria-pressed', String(key === selected));
    const number = document.createElement('span'); number.className = 'day-number'; number.textContent = String(date.getUTCDate());
    button.append(number);
    if (key === today) { const badge = document.createElement('span'); badge.className = 'today-label'; badge.textContent = '今天'; button.append(badge); }
    for (const event of events.slice(0, 2)) {
      const label = document.createElement('span'); label.className = 'event-label'; label.textContent = event.name;
      button.append(label);
    }
    if (events.length > 2) { const more = document.createElement('span'); more.className = 'more'; more.textContent = `另有 ${events.length - 2} 项`; button.append(more); }
    button.addEventListener('click', () => selectDate(key));
    fragment.append(button);
  }
  el('days').replaceChildren(fragment);
  el('date-title').textContent = `${selected} 的事件`;
  const list = document.createDocumentFragment();
  for (const event of matching(selected)) {
    const card = document.createElement('article'); card.className = 'event-card';
    const title = document.createElement('h3'); title.textContent = event.name;
    const time = document.createElement('p'); time.className = 'event-time';
    time.textContent = event.startDate !== event.endDate ? `${event.startDate} 至 ${event.endDate} · ${event.time}` : event.time;
    const detail = document.createElement('p'); detail.textContent = event.detail;
    const source = document.createElement('p'); source.className = 'source'; source.textContent = event.provenance;
    card.append(title, time, detail, source);
    if (event.hasSource) {
      const link = document.createElement('button'); link.className = 'source-link'; link.type = 'button'; link.textContent = '查看来源 ↗';
      link.addEventListener('click', () => post('source', event.id)); card.append(link);
    }
    list.append(card);
  }
  if (!list.childNodes.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '当天暂无已收录的事件'; list.append(empty); }
  el('events').replaceChildren(list);
}
function moveMonth(delta: number) {
  const next = new Date(Date.UTC(year, month + delta, 1));
  if (next.getUTCFullYear() < 1900 || next.getUTCFullYear() > 2100) return;
  selectDate(iso(next));
}
el('prev').addEventListener('click', () => moveMonth(-1));
el('next').addEventListener('click', () => moveMonth(1));
el('today').addEventListener('click', () => selectDate(today));
el('month').addEventListener('change', () => {
  const value = (el('month') as HTMLInputElement).value;
  if (/^(19\d{2}|20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(value)) selectDate(`${value}-01`);
  else render();
});
el('refresh').addEventListener('click', () => post('refresh'));
el('filter').addEventListener('change', render);
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.token !== token || message.type !== 'state') return;
  items = message.events; today = message.today;
  el('status').textContent = message.status;
  if (!selected) selectDate(today); else render();
});
post('ready');
