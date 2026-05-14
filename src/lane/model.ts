import type { AbsolutePath, LaneId, UriString } from '../foundation/model';

/** ワークスペース内の単一プロジェクト */
export interface Lane {
  /** レーン識別子 */
  readonly id: LaneId;
  /** 表示ラベル */
  readonly label: string;
  /** レーンルート URI */
  readonly rootUri: UriString;
  /** レーンルート絶対パス */
  readonly rootPath: AbsolutePath;
}

/** レーンカタログ */
export interface LaneCatalog {
  /** レーン列 */
  readonly lanes: readonly Lane[];
  /** ID 逆引き表 */
  readonly byId: ReadonlyMap<LaneId, Lane>;
}

/** 個別タブの保存情報 */
export interface EditorTabSnapshot {
  /** タブ URI */
  readonly uri: UriString;
  /** ビュー列インデックス */
  readonly viewColumn: number;
}

/** エディタ状態のスナップショット */
export interface EditorSnapshot {
  /** タブ列 */
  readonly tabs: readonly EditorTabSnapshot[];
}

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
   * エディタ状態の破棄
   * @param laneId - 対象レーン識別子
   */
  readonly clear: (laneId: LaneId) => void;
}

/** レーンサービスの現在状態 */
export interface LaneServiceSnapshot {
  /** 現在のカタログ */
  readonly catalog: LaneCatalog;
  /** 活性レーン識別子 */
  readonly activeLaneId: LaneId | undefined;
}

/** フォーカス判定の結果 */
export type LaneFocusPlan =
  | {
      /** 操作不要 */
      readonly kind: 'noop';
      /** 不要理由 */
      readonly reason: 'same-lane' | 'no-target';
    }
  | {
      /** 実行阻害 */
      readonly kind: 'blocked';
      /** 阻害理由 */
      readonly reason: 'dirty-editors';
    }
  | {
      /** 切替実行 */
      readonly kind: 'focus';
      /** 切替元レーン */
      readonly from: Lane | undefined;
      /** 切替先レーン */
      readonly to: Lane;
    };
