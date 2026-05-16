import type { AbsolutePath, LaneId, UriString } from '../foundation/model';

/**
 * ラベルから LaneId への変換
 *
 * 本リポジトリでは `Lane.id === Lane.label` の不変条件を取り、表示ラベルがそのまま識別子を兼ねる。
 * すべての LaneId 生成は本関数を経由し、`as LaneId` の散在を防ぐ。
 * @param label - 表示ラベル
 * @returns 同一文字列の LaneId
 */
export const toLaneId = (label: string): LaneId => label as LaneId;

/** ワークスペース内の単一プロジェクト */
export interface Lane {
  /** レーン識別子、`label` と同一の文字列 */
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
