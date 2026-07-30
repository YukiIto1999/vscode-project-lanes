import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';
import type { EditorSnapshot, Lane } from './model';

/** 永続化されたレーン選択 */
export type StoredLaneSelection =
  | {
      /** 現行形式 */
      readonly kind: 'v2';
      /** 不透明レーン識別子 */
      readonly laneId: LaneId;
    }
  | {
      /** v0.1.13 以前の label 文字列 */
      readonly kind: 'legacy';
      /** 当時の表示ラベル */
      readonly label: string;
    };

/** エディタ状態のカタログ収束結果 */
export type EditorSnapshotPruneResult = 'unchanged' | 'pruned' | 'protected';

/** レーン別エディタ状態の永続化ストア */
export interface EditorSnapshotStorePort {
  /**
   * エディタ状態の保存
   * @param laneId - 対象レーン識別子
   * @param snapshot - 保存対象スナップショット
   */
  readonly save: (laneId: LaneId, snapshot: EditorSnapshot) => Promise<void>;
  /**
   * エディタ状態の取得
   * @param laneId - 対象レーン識別子
   * @returns 保存済みスナップショット、または未保存で undefined
   */
  readonly get: (laneId: LaneId) => EditorSnapshot | undefined;
  /**
   * エディタ状態の破棄
   * @param laneId - 対象レーン識別子
   */
  readonly remove: (laneId: LaneId) => Promise<void>;
  /**
   * 現行カタログに存在しないエディタ状態の除外
   * @param retainedLaneIds - 維持するレーン識別子列
   * @returns 変更有無、または将来スキーマ保護
   */
  readonly prune: (retainedLaneIds: readonly LaneId[]) => Promise<EditorSnapshotPruneResult>;
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
   * @returns 全タブを破棄できた場合は true
   */
  readonly closeAll: () => Promise<boolean>;
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
   * @returns workspace folder mutation が受理された場合は true
   */
  readonly rebindActiveFolder: (activeLane: Lane) => Promise<boolean>;
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
   * 指定レーンの表示面を現在の表示名で再生成
   * @param lane - 対象レーン
   * @returns 再生成完了の Promise
   */
  readonly refreshLane: (lane: Lane) => Promise<void>;
  /**
   * 保留中の表示面更新を失敗した段階から再開
   * @returns 再開完了の Promise
   */
  readonly finalizePendingPresentations: () => Promise<void>;
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
  readonly load: (key: WorkspaceKey) => StoredLaneSelection | undefined;
  /**
   * 選択レーンの保存
   * @param key - ワークスペース永続キー
   * @param laneId - 対象レーン識別子
   * @returns 保存完了の Promise
   */
  readonly save: (key: WorkspaceKey, laneId: LaneId | undefined) => Promise<void>;
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
  /**
   * レーンルート差替先の単一フォルダ選択
   * @param defaultDirectory - 初期表示ディレクトリ
   * @returns 選択フォルダの URI、取消で undefined
   */
  readonly pickReplacementFolder: (
    defaultDirectory: AbsolutePath,
  ) => Promise<UriString | undefined>;
  /** フォルダ追加の反映失敗時の警告 */
  readonly warnAddFolderFailed: () => void;
}
