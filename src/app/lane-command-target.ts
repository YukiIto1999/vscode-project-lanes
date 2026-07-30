import type { LaneId } from '../foundation/model';
import { toLaneId, type LaneCatalog } from '../lane/model';

const commandArgumentValue = (argument: unknown): string | undefined => {
  if (typeof argument === 'string') return argument;
  if (!argument || typeof argument !== 'object') return undefined;
  const fields = argument as { laneId?: unknown; id?: unknown };
  if (typeof fields.laneId === 'string') return fields.laneId;
  return typeof fields.id === 'string' ? fields.id : undefined;
};

/**
 * VS Code コマンド引数からの LaneId 解決
 * @param argument - コマンドコールバック第一引数
 * @param catalog - 評価時点のレーンカタログ
 * @returns ID 一致または一意な旧 label 一致、解決不能なら undefined
 */
export const resolveLaneCommandTarget = (
  argument: unknown,
  catalog: LaneCatalog,
): LaneId | undefined => {
  const value = commandArgumentValue(argument);
  if (value === undefined) return undefined;
  const id = toLaneId(value);
  if (catalog.byId.has(id)) return id;
  const labelMatches = catalog.lanes.filter((lane) => lane.label === value);
  return labelMatches.length === 1 ? labelMatches[0]!.id : undefined;
};
