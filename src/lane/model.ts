import type { AbsolutePath, LaneId, UriString } from '../foundation/model';

/** レーンルートの現在の利用可否 */
export type LaneRootAvailability = 'available' | 'missing' | 'inaccessible';

/**
 * 永続化・外部入力文字列から LaneId への変換
 * @param value - 不透明識別子の文字列表現
 * @returns 同一文字列の LaneId
 */
export const toLaneId = (value: string): LaneId => value as LaneId;

/**
 * 永続化可能な不透明 LaneId かを判定
 * @param value - 判定対象
 * @returns UUID または v1 migration 由来 SHA-256 なら true
 */
export const isCanonicalLaneId = (value: string): boolean =>
  /^[0-9a-f]{64}$/.test(value) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

/** ワークスペース内の単一プロジェクト */
export interface Lane {
  /** 表示名や所在変更では変わらない不透明識別子 */
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
      readonly reason: 'dirty-editors' | 'reconciliation-required' | 'root-unavailable';
    }
  | {
      /** 切替失敗 */
      readonly kind: 'failed';
      /** 失敗理由 */
      readonly reason: 'transition-failed';
      /** transition または補償の失敗原因 */
      readonly error: unknown;
    }
  | {
      /** 切替実行 */
      readonly kind: 'focus';
      /** 切替元レーン */
      readonly from: Lane | undefined;
      /** 切替先レーン */
      readonly to: Lane;
    };
