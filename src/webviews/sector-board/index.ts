export {};
interface Row {
  code: string;
  name: string;
  percent: number;
  volume: number | null;
  amount: number | null;
  turnover: number | null;
  marketCap: number | null;
  up: number | null;
  down: number | null;
  leader: string;
  leaderPercent: number | null;
  timestamp: number | null;
}
interface Snapshot {
  category: string;
  rows: Row[];
  total: number;
  fetchedAt: number;
  source: string;
}
declare function acquireVsCodeApi(): { postMessage(value: unknown): void };
const vscode = acquireVsCodeApi(),
  token = document.body.dataset.token;
const $ = (id: string) => document.getElementById(id)!;
let category = 'industry',
  direction = 'gainers',
  view = 'table',
  sort = 'percent',
  data: Snapshot | null = null,
  stale = false;
const post = (action: string, value?: string) => vscode.postMessage({ token, action, value });
const n = (x: number | null) => (x == null ? '—' : x.toFixed(2));
const pct = (x: number | null) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(2)}%`);
const scale = (x: number | null, unit: string) =>
  x == null
    ? '—'
    : x >= 1e8
      ? `${(x / 1e8).toFixed(2)}亿${unit}`
      : x >= 1e4
        ? `${(x / 1e4).toFixed(2)}万${unit}`
        : `${x.toFixed(0)}${unit}`;
const time = (stamp: number) => new Date(stamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function line(row: Row) {
  return `${row.name}  ${pct(row.percent)}  ·  成交额 ${scale(row.amount, '元')}  ·  成交量 ${scale(row.volume, '手')}  ·  换手 ${row.turnover === null ? '—' : n(row.turnover) + '%'}  ·  总市值 ${scale(row.marketCap, '元')}  ·  上涨 ${row.up ?? '—'} / 下跌 ${row.down ?? '—'}  ·  领涨 ${row.leader || '—'} ${pct(row.leaderPercent)}`;
}
function select(row: Row) {
  const el = $('detail');
  el.hidden = false;
  el.textContent = line(row);
}
function color(percent: number) {
  const level = Math.min(1, Math.abs(percent) / 6);
  return percent > 0
    ? `rgb(${Math.round(105 + 105 * level)},${Math.round(28 + 20 * level)},${Math.round(40 + 20 * level)})`
    : percent < 0
      ? `rgb(${Math.round(16 + 12 * level)},${Math.round(82 + 55 * level)},${Math.round(55 + 25 * level)})`
      : 'rgb(70,80,92)';
}
function updateButtons() {
  for (const el of document.querySelectorAll<HTMLButtonElement>('[data-category]'))
    el.classList.toggle('active', el.dataset.category === category);
  for (const el of document.querySelectorAll<HTMLButtonElement>('[data-direction]'))
    el.classList.toggle('active', el.dataset.direction === direction);
  for (const el of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    el.classList.toggle('active', el.dataset.view === view);
  $('table-view').hidden = view !== 'table';
  $('heatmap-view').hidden = view !== 'heatmap';
}
function render() {
  updateButtons();
  if (!data) {
    $('rows').replaceChildren();
    $('heatmap').replaceChildren();
    $('summary').textContent = '';
    return;
  }
  const quoteTimes = data.rows.map((r) => r.timestamp).filter((x): x is number => x !== null);
  $('status').textContent =
    `${data.source} · 获取时间 ${time(data.fetchedAt)}（北京）${quoteTimes.length ? ` · 最早行情 ${time(Math.min(...quoteTimes) * 1000)}` : ' · 未提供行情时间'}${stale ? ' · 上次数据' : ''}`;
  $('summary').textContent =
    `${category === 'industry' ? '行业' : '概念'}板块 ${data.rows.length} 个${data.rows.length < data.total ? `（接口共 ${data.total} 个，部分数据缺失或重复）` : ''} · 上涨 ${data.rows.filter((r) => r.percent > 0).length} · 下跌 ${data.rows.filter((r) => r.percent < 0).length}`;
  const query = ($('search') as HTMLInputElement).value.trim().toLowerCase();
  const list = data.rows
    .filter((r) => !query || r.name.toLowerCase().includes(query) || r.code.toLowerCase().includes(query))
    .sort((a, b) => {
      const av = a[sort as 'percent' | 'amount' | 'volume'],
        bv = b[sort as 'percent' | 'amount' | 'volume'];
      if (av === null) return bv === null ? 0 : 1;
      if (bv === null) return -1;
      return (sort === 'percent' && direction === 'losers' ? 1 : -1) * (av - bv) || a.code.localeCompare(b.code);
    });
  $('count').textContent = `${list.length} 个板块`;
  const fragment = document.createDocumentFragment();
  list.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.title = '点击查看板块信息';
    tr.addEventListener('click', () => select(row));
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(row);
      }
    });
    const cells = [
      String(i + 1),
      row.name,
      pct(row.percent),
      scale(row.amount, '元'),
      scale(row.volume, '手'),
      row.turnover == null ? '—' : `${n(row.turnover)}%`,
      `${row.up ?? '—'} / ${row.down ?? '—'}`,
      `${row.leader || '—'} ${row.leaderPercent === null ? '' : pct(row.leaderPercent)}`
    ];
    cells.forEach((v, k) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (k === 2) td.className = row.percent > 0 ? 'up' : row.percent < 0 ? 'down' : '';
      tr.appendChild(td);
    });
    fragment.appendChild(tr);
  });
  $('rows').replaceChildren(fragment);
  if (view === 'heatmap') renderMap(data.rows);
}
// 按成交额递归切分矩形，面积比例来自真实数据；不把缺失值填成零。
function renderMap(rows: Row[]) {
  const all = rows.filter((r) => r.amount !== null && r.amount > 0).sort((a, b) => b.amount! - a.amount!);
  const list = all.slice(0, 120),
    map = $('heatmap');
  map.replaceChildren();
  $('coverage').textContent = `成交额前 ${list.length} / ${all.length} 个板块`;
  if (!list.length) {
    map.textContent = '暂无可用于绘制云图的成交额数据';
    return;
  }
  const draw = (items: Row[], x: number, y: number, w: number, h: number) => {
    if (items.length === 1) {
      const r = items[0],
        b = document.createElement('button');
      b.className = 'tile';
      b.style.left = `${x}%`;
      b.style.top = `${y}%`;
      b.style.width = `${w}%`;
      b.style.height = `${h}%`;
      b.style.backgroundColor = color(r.percent);
      b.title = line(r);
      b.setAttribute('aria-label', line(r));
      const name = document.createElement('strong'),
        p = document.createElement('span');
      name.textContent = r.name;
      p.textContent = pct(r.percent);
      b.append(name, p);
      b.addEventListener('click', () => select(r));
      map.appendChild(b);
      return;
    }
    const sum = items.reduce((a, r) => a + r.amount!, 0);
    let part = 0,
      split = 1;
    while (split < items.length && part + items[split - 1].amount! < sum / 2) {
      part += items[split - 1].amount!;
      split++;
    }
    part = items.slice(0, split).reduce((a, r) => a + r.amount!, 0);
    const ratio = part / sum;
    if (w >= h) {
      draw(items.slice(0, split), x, y, w * ratio, h);
      draw(items.slice(split), x + w * ratio, y, w * (1 - ratio), h);
    } else {
      draw(items.slice(0, split), x, y, w, h * ratio);
      draw(items.slice(split), x, y + h * ratio, w, h * (1 - ratio));
    }
  };
  draw(list, 0, 0, 100, 100);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-category]'))
  b.addEventListener('click', () => {
    if (b.dataset.category !== category) post('category', b.dataset.category);
  });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-direction]'))
  b.addEventListener('click', () => {
    sort = 'percent';
    if (b.dataset.direction !== direction) post('direction', b.dataset.direction);
  });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
  b.addEventListener('click', () => {
    view = b.dataset.view!;
    render();
  });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sort]'))
  b.addEventListener('click', () => {
    sort = b.dataset.sort!;
    render();
  });
$('refresh').addEventListener('click', () => post('refresh'));
$('search').addEventListener('input', render);
window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || m.token !== token) return;
  if (m.type === 'state') {
    category = m.category;
    direction = m.direction;
    data = m.data;
    stale = !!m.stale;
    $('detail').hidden = true;
    render();
    if (!data) $('status').textContent = '正在获取板块数据…';
  }
  if (m.type === 'loading' || m.type === 'error' || m.type === 'message') $('status').textContent = m.message;
});
updateButtons();
post('ready');
