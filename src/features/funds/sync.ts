import type { Memento } from 'vscode';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fundCode, holdingPosition } from './data';

const HOLDINGS_SYNC_KEY = 'fundHoldingsCloudV1';
const LOCAL_REVISIONS_KEY = 'fundHoldingsRevisionsV1';
type Position = { shares: number; cost: number };
type Revision = { at: number; id: string; position: Position | null };
type Records = Record<string, Revision>;
const same = isDeepStrictEqual;
function readRecords(value: any): Records {
  const records: Records = {};
  if (value?.version !== 1 || !value.records || typeof value.records !== 'object') return records;
  for (const [code, item] of Object.entries(value.records) as [string, any][]) {
    try {
      if (
        !Number.isSafeInteger(item.at) ||
        item.at < 0 ||
        typeof item.id !== 'string' ||
        !/^[\w-]{1,64}$/.test(item.id)
      )
        continue;
      records[fundCode(code)] = {
        at: item.at,
        id: item.id,
        position: item.position === null ? null : holdingPosition(item.position)
      };
    } catch {
      /* 损坏或多余字段不能进入持仓。 */
    }
  }
  return records;
}
function readPositions(value: unknown): Record<string, Position> {
  const positions: Record<string, Position> = {};
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [code, position] of Object.entries(value)) {
      try {
        positions[fundCode(code)] = holdingPosition(position);
      } catch {
        /* 忽略异常持仓。 */
      }
    }
  return positions;
}

/** 本机持仓与云端副本分开，关闭同步不会清空持仓，也不会上传之后的本机修改。 */
class HoldingsSync {
  private queue = Promise.resolve();
  constructor(
    private state: Memento,
    private enabled: () => boolean,
    private now = Date.now
  ) {}

  reconcile(): Promise<void> {
    const write = this.queue
      .catch(() => {})
      .then(async () => {
        const local = readPositions(this.state.get('fundHoldings'));
        const saved = this.state.get(LOCAL_REVISIONS_KEY),
          records = readRecords(saved);
        const initialized = Boolean(saved && typeof saved === 'object' && 'version' in saved && saved.version === 1);
        // 记录每只基金的修改时间和删除标记；避免不同设备修改不同基金时整表相互覆盖。
        for (const code of new Set([...Object.keys(local), ...Object.keys(records)])) {
          const position = local[code] || null;
          if (same(records[code]?.position ?? null, position)) continue;
          records[code] = {
            at: initialized ? Math.max(this.now(), (records[code]?.at || 0) + 1) : 0,
            id: randomUUID(),
            position
          };
        }
        if (this.enabled()) {
          const remote = readRecords(this.state.get(HOLDINGS_SYNC_KEY));
          for (const [code, item] of Object.entries(remote)) {
            const own = records[code];
            // 旧版持仓没有修改时间，优先云端已有记录；本机独有的基金仍会保留并上传。
            if (!own || own.at === 0 || item.at > own.at || (item.at === own.at && item.id > own.id))
              records[code] = item;
          }
          const merged = Object.fromEntries(
            Object.entries(records)
              .filter(([, item]) => item.position)
              .map(([code, item]) => [code, item.position])
          );
          if (this.enabled() && !same(local, merged)) await this.state.update('fundHoldings', merged);
          const payload = { version: 1, records };
          if (this.enabled() && !same(remote, records)) await this.state.update(HOLDINGS_SYNC_KEY, payload);
        }
        const next = { version: 1, records };
        if (!same(saved, next)) await this.state.update(LOCAL_REVISIONS_KEY, next);
      });
    this.queue = write;
    return write;
  }
}
export { HoldingsSync, HOLDINGS_SYNC_KEY, readPositions };
