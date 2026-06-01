import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';
import type { EditorSnapshot, Lane } from './model';

/** レーン別エディタ状態の保存ストア */
export interface LaneSessionStore {
  /**
   * エディタ状態の保存
   * @param laneId - 対象レーン識別子
   * @param snapshot - 保存対象スナップショット
   */
  readonly save: (laneId: LaneId, snapshot: EditorSnapshot) => void;
  /**
   * エディタ状態の取得
   * @param laneId - 対象レーン識別子
   * @returns 保存済みスナップショット、または未保存で undefined
   */
  readonly get: (laneId: LaneId) => EditorSnapshot | undefined;
  /**
   * エディタ状態のキー張替え
   * @param oldLaneId - 旧レーン識別子
   * @param newLaneId - 新レーン識別子
   */
  readonly rekey: (oldLaneId: LaneId, newLaneId: LaneId) => void;
  /**
   * エディタ状態の破棄
   * @param laneId - 対象レーン識別子
   */
  readonly clear: (laneId: LaneId) => void;
}

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
  /**
   * リネーム入力ダイアログ
   * @param current - 現在のラベル
   * @param validate - エラー時はメッセージ、OK 時は undefined を返す純粋検証関数
   * @returns 入力された生入力、または取消で undefined
   */
  readonly promptRename: (
    current: string,
    validate: (input: string) => string | undefined,
  ) => Promise<string | undefined>;
  /**
   * modal による削除確認
   * @param lane - 削除対象レーン
   * @returns OK で true、キャンセルで false
   */
  readonly confirmRemoval: (lane: Lane) => Promise<boolean>;
  /** アクティブレーン削除を試みた際の警告 */
  readonly warnActiveLaneRemoval: () => void;
  /**
   * 追加フォルダ選択ダイアログ
   * @param defaultDirectory - 初期表示ディレクトリ
   * @returns 選択フォルダの URI 列、取消で空配列
   */
  readonly pickFoldersToAdd: (defaultDirectory: AbsolutePath) => Promise<readonly UriString[]>;
}
