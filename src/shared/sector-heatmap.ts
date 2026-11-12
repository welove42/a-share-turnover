export type SectorHeatmapMode = 'amount' | 'gainers' | 'losers';

interface HeatmapRow {
  code: string;
  percent: number;
  amount: number | null;
}

/** 选取和绘图使用同一权重，避免板块不足50个时切换依据却显示相同布局。 */
export function sectorHeatmapWeight(row: HeatmapRow, mode: SectorHeatmapMode): number {
  const value = mode === 'amount' ? row.amount : mode === 'losers' ? -row.percent : row.percent;
  return value !== null && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 涨幅仅显示上涨板块，跌幅仅显示下跌板块；不足50个时不拿反向板块补足。 */
export function selectSectorHeatmapRows<T extends HeatmapRow>(rows: readonly T[], mode: SectorHeatmapMode): T[] {
  return rows
    .filter((row) => sectorHeatmapWeight(row, mode) > 0)
    .sort(
      (left, right) =>
        sectorHeatmapWeight(right, mode) - sectorHeatmapWeight(left, mode) || left.code.localeCompare(right.code)
    )
    .slice(0, 50);
}
