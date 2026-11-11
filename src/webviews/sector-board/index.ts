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
  page = 1,
  data: Snapshot | null = null,
  stale = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const post = (action: string, value?: unknown) => vscode.postMessage({ token, action, value });
const query = () => ({ view, sort, page, search: ($('search') as HTMLInputElement).value.trim() });
function requestPage() {
  data = null;
  $('detail').hidden = true;
  render();
  $('status').textContent = '正在获取板块数据…';
  post('query', query());
}
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
    $('count').textContent = '';
    for (const el of document.querySelectorAll<HTMLElement>('[data-page-info]')) el.textContent = '0 / 0 页';
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-page]')) b.disabled = true;
    return;
  }
  const quoteTimes = data.rows.map((r) => r.timestamp).filter((x): x is number => x !== null);
  $('status').textContent =
    `${data.source} · 获取时间 ${time(data.fetchedAt)}（北京）${quoteTimes.length ? ` · 最早行情 ${time(Math.min(...quoteTimes) * 1000)}` : ' · 未提供行情时间'}${stale ? ' · 上次数据' : ''}`;
  const search = ($('search') as HTMLInputElement).value.trim();
  $('summary').textContent = search && view === 'table' ? '搜索全部板块：从最多100个候选中显示最多30个板块，可能不完整。' : `${category === 'industry' ? '行业' : '概念'}板块共 ${data.total} 个 · 数据按当前排序获取`;
  const list = data.rows;
  const pageSize = 30, pages = Math.ceil(data.total / pageSize);
  if (view === 'table' && pages && page > pages) { page = pages; requestPage(); return; }
  page = Math.max(1, Math.min(page, pages || 1));
  const start = (page - 1) * pageSize;
  $('count').textContent = search ? `本次找到 ${data.total} 个板块` : `共 ${data.total} 个板块`;
  for (const el of document.querySelectorAll<HTMLElement>('[data-page-info]'))
    el.textContent = `${pages ? page : 0} / ${pages} 页`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-page]'))
    b.disabled = b.dataset.page === 'previous' ? page <= 1 : page >= pages;
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
      String(start + i + 1),
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
  if (!list.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'empty';
    td.textContent = '没有找到匹配的板块';
    tr.appendChild(td);
    fragment.appendChild(tr);
  }
  $('rows').replaceChildren(fragment);
  if (view === 'heatmap') renderMap(data.rows);
}
// 按真实像素尺寸布局，尽量保持方块接近正方形，同时保留成交额面积比例。
function renderMap(rows: Row[]) {
  const all = rows.filter((r) => r.amount !== null && r.amount > 0).sort((a, b) => b.amount! - a.amount!);
  const list = all.slice(0, 50),
    map = $('heatmap');
  map.replaceChildren();
  $('coverage').textContent = `成交额前 ${list.length} / ${data?.total || all.length} 个板块`;
  if (!list.length) {
    map.textContent = '暂无可用于绘制云图的成交额数据';
    return;
  }
  const width = map.clientWidth || 900, height = map.clientHeight || 760;
  const total = list.reduce((sum, r) => sum + r.amount!, 0);
  const remaining = list.map((row) => ({ row, area: row.amount! / total * width * height }));
  const worst = (items: typeof remaining, side: number) => {
    if (!items.length || side <= 0) return Infinity;
    const sum = items.reduce((n, item) => n + item.area, 0), areas = items.map((item) => item.area), square = side * side;
    return Math.max(square * Math.max(...areas) / (sum * sum), (sum * sum) / (square * Math.min(...areas)));
  };
  const tile = (r: Row, x: number, y: number, w: number, h: number) => {
      const b = document.createElement('button');
      b.className = 'tile';
      b.style.left = `${x / width * 100}%`;
      b.style.top = `${y / height * 100}%`;
      b.style.width = `${w / width * 100}%`;
      b.style.height = `${h / height * 100}%`;
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
  };
  let x = 0, y = 0, w = width, h = height;
  while (remaining.length) {
    const group = [remaining.shift()!];
    while (remaining.length && worst([...group, remaining[0]], Math.min(w, h)) <= worst(group, Math.min(w, h)))
      group.push(remaining.shift()!);
    const area = group.reduce((sum, item) => sum + item.area, 0);
    if (w >= h) {
      const strip = area / h;
      let position = y;
      for (const item of group) { const size = item.area / strip; tile(item.row, x, position, strip, size); position += size; }
      x += strip; w -= strip;
    } else {
      const strip = area / w;
      let position = x;
      for (const item of group) { const size = item.area / strip; tile(item.row, position, y, size, strip); position += size; }
      y += strip; h -= strip;
    }
  }
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (view === 'heatmap' && data) renderMap(data.rows); }).observe($('heatmap'));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-category]'))
  b.addEventListener('click', () => {
    if (b.dataset.category !== category) post('category', b.dataset.category);
  });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-direction]'))
  b.addEventListener('click', () => {
    sort = 'percent';
    page = 1;
    if (b.dataset.direction !== direction) post('direction', b.dataset.direction);
    else requestPage();
  });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
  b.addEventListener('click', () => {
    view = b.dataset.view!;
    page = 1;
    requestPage();
  });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-sort]'))
  b.addEventListener('click', () => {
    sort = b.dataset.sort!;
    page = 1;
    requestPage();
  });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-page]'))
  b.addEventListener('click', () => {
    page += b.dataset.page === 'previous' ? -1 : 1;
    $('detail').hidden = true;
    requestPage();
  });
$('refresh').addEventListener('click', () => post('refresh'));
$('search').addEventListener('input', () => { page = 1; clearTimeout(searchTimer); searchTimer = setTimeout(requestPage, 400); });
window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || m.token !== token) return;
  if (m.type === 'state') {
    if (m.query && (m.query.view !== view || m.query.search !== query().search || (m.query.page !== page && m.category === category && m.direction === direction) || m.query.sort !== sort)) return;
    if (m.category !== category || m.direction !== direction) page = 1;
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
