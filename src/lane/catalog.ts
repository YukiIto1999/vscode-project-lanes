import type { AbsolutePath, LaneId } from '../foundation/model';
import { isDescendantOf } from '../foundation/path';
import type { LaneCatalog } from './model';

/**
 * cwd からのレーン識別子解決
 * @param cwd - 対象作業ディレクトリ
 * @param catalog - 解決元カタログ
 * @returns 該当レーン識別子、または不一致で undefined
 */
export const resolveLaneId = (cwd: AbsolutePath, catalog: LaneCatalog): LaneId | undefined =>
  catalog.lanes.find((lane) => isDescendantOf(cwd, lane.rootPath))?.id;
