import type { AbsolutePath, LaneId } from '../foundation/model';
import { isDescendantOf } from '../foundation/path';
import type { LaneCatalog } from './model';

/** cwd からレーン ID への解決（cwd がレーンルート配下にある場合に一致） */
export const resolveLaneId = (cwd: AbsolutePath, catalog: LaneCatalog): LaneId | undefined =>
  catalog.lanes.find((lane) => isDescendantOf(cwd, lane.rootPath))?.id;
