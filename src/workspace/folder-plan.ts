import type { Lane, LaneCatalog } from '../lane/model';
import type { FolderMutation } from './model';

/** 指定レーンのみ表示するフォルダ変更操作の算出（index 0 のアンカーは固定） */
export const planFocusLane = (currentFolderCount: number, lane: Lane): FolderMutation => ({
  start: 1,
  deleteCount: currentFolderCount - 1,
  folders: [{ uri: lane.rootUri, name: lane.label }],
});

/** 全レーンを表示するフォルダ変更操作の算出 */
export const planRevealAll = (
  currentFolderCount: number,
  catalog: LaneCatalog,
): FolderMutation => ({
  start: 1,
  deleteCount: currentFolderCount - 1,
  folders: catalog.lanes.map((l) => ({ uri: l.rootUri, name: l.label })),
});
