import type { LaneId, WorkspaceKey } from '../foundation/model';
import type { EditorSnapshot, Lane } from './model';

/** エディタ操作ポート */
export interface EditorPort {
  readonly hasDirtyEditors: () => boolean;
  readonly captureSnapshot: () => EditorSnapshot;
  readonly closeAll: () => Promise<void>;
  readonly restoreSnapshot: (snapshot: EditorSnapshot) => Promise<void>;
}

/** Explorer 可視性ポート */
export interface LaneVisibilityPort {
  readonly focusLane: (lane: Lane) => void;
  readonly revealAllLanes: (lanes: readonly Lane[]) => void;
}

/** ターミナル切替ポート */
export interface LaneTerminalPort {
  readonly revealLane: (lane: Lane) => Promise<void>;
  readonly closeLane: (laneId: LaneId) => Promise<void>;
}

/** レーン選択の永続化ポート */
export interface LaneSelectionStorePort {
  readonly load: (key: WorkspaceKey) => LaneId | undefined;
  readonly save: (key: WorkspaceKey, laneId: LaneId | undefined) => void;
}

/** ユーザー対話ポート */
export interface LanePromptPort {
  readonly pickLane: (lanes: readonly Lane[]) => Promise<LaneId | undefined>;
  readonly warnDirtyEditors: () => void;
}
