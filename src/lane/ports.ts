import type { LaneId, WorkspaceKey } from '../foundation/model';
import type { EditorSnapshot, Lane } from './model';

/** エディタ操作ポート */
export interface EditorPort {
  /**
   * 未保存タブの有無判定
   * @returns 未保存タブがあれば true
   */
  readonly hasDirtyEditors: () => boolean;
  /**
   * エディタ状態の取得
   * @returns 現状のスナップショット
   */
  readonly captureSnapshot: () => EditorSnapshot;
  /**
   * 全タブの破棄
   * @returns 破棄完了の Promise
   */
  readonly closeAll: () => Promise<void>;
  /**
   * エディタ状態の復元
   * @param snapshot - 復元対象スナップショット
   * @returns 復元完了の Promise
   */
  readonly restoreSnapshot: (snapshot: EditorSnapshot) => Promise<void>;
}

/** レーン切替後の VS Code ビュー再走査ポート */
export interface LaneViewRebindPort {
  /**
   * 切替先レーンへの active folder ビューの再走査要求
   * @param activeLane - 切替先レーン
   * @returns 再走査要求の完了 Promise
   */
  readonly rebindActiveFolder: (activeLane: Lane) => Promise<void>;
}

/** ターミナル切替ポート */
export interface LaneTerminalPort {
  /**
   * 指定レーンのターミナルを表示
   * @param lane - 対象レーン
   * @returns 表示完了の Promise
   */
  readonly revealLane: (lane: Lane) => Promise<void>;
  /**
   * 指定レーンのターミナルを破棄
   * @param laneId - 対象レーン識別子
   * @returns 破棄完了の Promise
   */
  readonly closeLane: (laneId: LaneId) => Promise<void>;
}

/** レーン選択の永続化ポート */
export interface LaneSelectionStorePort {
  /**
   * 選択レーンの読込
   * @param key - ワークスペース永続キー
   * @returns 永続化済みレーン識別子、または未保存で undefined
   */
  readonly load: (key: WorkspaceKey) => LaneId | undefined;
  /**
   * 選択レーンの保存
   * @param key - ワークスペース永続キー
   * @param laneId - 対象レーン識別子
   */
  readonly save: (key: WorkspaceKey, laneId: LaneId | undefined) => void;
}

/** ユーザー対話ポート */
export interface LanePromptPort {
  /**
   * レーン選択ダイアログ
   * @param lanes - 候補レーン列
   * @returns 選択レーン識別子、または取消で undefined
   */
  readonly pickLane: (lanes: readonly Lane[]) => Promise<LaneId | undefined>;
  /** 未保存タブ警告の表示 */
  readonly warnDirtyEditors: () => void;
}
