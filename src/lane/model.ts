import type { AbsolutePath, LaneId, UriString } from '../foundation/model';

/** ワークスペース内の1プロジェクト */
export interface Lane {
  readonly id: LaneId;
  readonly label: string;
  readonly rootUri: UriString;
  readonly rootPath: AbsolutePath;
}

/** レーンカタログ（一覧と ID 逆引き） */
export interface LaneCatalog {
  readonly lanes: readonly Lane[];
  readonly byId: ReadonlyMap<LaneId, Lane>;
}

/** 個別タブの保存情報 */
export interface EditorTabSnapshot {
  readonly uri: UriString;
  readonly viewColumn: number;
}

/** レーン切替時に保存・復元するエディタ状態 */
export interface EditorSnapshot {
  readonly tabs: readonly EditorTabSnapshot[];
}

/** レーン別エディタ状態のストア */
export interface LaneSessionStore {
  readonly save: (laneId: LaneId, snapshot: EditorSnapshot) => void;
  readonly get: (laneId: LaneId) => EditorSnapshot | undefined;
  readonly clear: (laneId: LaneId) => void;
}

/** レーンサービスの現在状態 */
export interface LaneServiceSnapshot {
  readonly catalog: LaneCatalog;
  readonly activeLaneId: LaneId | undefined;
}

/** フォーカス判定の結果 */
export type LaneFocusPlan =
  | { readonly kind: 'noop'; readonly reason: 'same-lane' | 'no-target' }
  | { readonly kind: 'blocked'; readonly reason: 'dirty-editors' }
  | { readonly kind: 'focus'; readonly from: Lane | undefined; readonly to: Lane };
