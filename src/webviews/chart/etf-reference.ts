import type { EtfQuote } from '../../shared/types';

export interface EtfReferenceData {
  etfEligible?: boolean;
  etf?: EtfQuote;
  etfStatus?: string;
  etfError?: string;
}

/** 与鼠标选中的历史行情分区展示，不能把最新 IOPV 拼入历史 K 线明细。 */
export function renderEtfReference(root: HTMLElement, data: EtfReferenceData, now: number, failed = false): void {
  root.replaceChildren();
  root.hidden = !data.etfEligible || data.etfStatus === 'unavailable';
  if (root.hidden) return;
  const quote = data.etf;
  const timestamp = quote?.timestampMs;
  const validTime = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp <= now + 60000;
  const stale = validTime && now - timestamp > 5 * 60000;
  const title = document.createElement('div');
  title.className = 'etf-title';
  title.textContent = `ETF · 最新参考${failed ? ' · 更新失败，保留上次数据' : stale ? ' · 较早行情' : ''}`;
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  const rate = validTime ? quote?.premiumRate : null;
  const hasRate = typeof rate === 'number' && Number.isFinite(rate);
  const rateValue = hasRate
    ? `${rate > 0 ? '+' : ''}${rate.toFixed(2)}%${rate > 0 ? '（溢价）' : rate < 0 ? '（折价）' : '（平价）'}`
    : '—';
  const number = (value: number | null | undefined, digits: number) =>
    validTime && typeof value === 'number' && Number.isFinite(value) && value > 0 ? value.toFixed(digits) : '—';
  for (const [label, value, direction] of [
    ['折溢价率', rateValue, hasRate ? rate : 0],
    ['参考净值（IOPV）', number(quote?.iopv, 4), 0],
    ['场内现价', number(quote?.price, 3), 0]
  ] as const) {
    const row = document.createElement('div');
    row.className = 'detail-row';
    const name = document.createElement('span');
    name.className = 'detail-label';
    name.textContent = label + ' ';
    const text = document.createElement('span');
    text.className = `detail-value${direction > 0 ? ' rising' : direction < 0 ? ' falling' : ''}`;
    text.textContent = value;
    row.append(name, text);
    grid.append(row);
  }
  grid.title = '折溢价率 =（场内现价 ÷ IOPV − 1）× 100%。使用同一行情快照，IOPV 不是基金正式净值。';
  const meta = document.createElement('p');
  meta.className = 'etf-meta';
  const raw = quote?.quoteTimestamp;
  const time =
    raw && /^\d{14}$/.test(raw)
      ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12)}`
      : '—';
  meta.textContent = `行情时间 ${time}（北京） · ${quote?.source || '腾讯行情'}`;
  const note = document.createElement('p');
  note.className = 'etf-meta';
  note.textContent = 'IOPV 无独立更新时间，可能滞后；此处为最新参考，不随历史 K 线切换。';
  const status = document.createElement('p');
  status.className = 'etf-status';
  status.textContent =
    data.etfStatus === 'loading'
      ? '正在获取 ETF 参考数据…'
      : data.etfStatus === 'error'
        ? data.etfError || 'ETF 参考数据获取失败，可刷新重试。'
        : quote && !validTime
          ? '行情时间异常，暂不展示参考数值。'
          : quote?.notice || '';
  root.append(title, grid, meta, note, status);
}
