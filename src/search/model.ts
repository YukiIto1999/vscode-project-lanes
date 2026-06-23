import type { AbsolutePath, LaneId } from '../foundation/model';

/** 検証済みの横断検索クエリ */
export type LaneQuery = string & { readonly __brand: 'LaneQuery' };

/** レーン帰属判定の入力 */
export interface LaneRoot {
  /** レーン識別子 */
  readonly laneId: LaneId;
  /** レーンルート絶対パス */
  readonly rootPath: AbsolutePath;
}

/** 横断検索の単一ヒット */
export type LaneSearchResult =
  | {
      /** ファイル内一致 */
      readonly kind: 'content';
      /** 所属レーン識別子 */
      readonly laneId: LaneId;
      /** 実体の絶対パス */
      readonly path: AbsolutePath;
      /** レーンルートからの相対パス */
      readonly relativePath: string;
      /** 一致行番号、1 始まり */
      readonly line: number;
      /** 一致桁、1 始まり */
      readonly column: number;
      /** 一致行のテキスト、trim 済み */
      readonly preview: string;
    }
  | {
      /** ファイル名一致 */
      readonly kind: 'file';
      /** 所属レーン識別子 */
      readonly laneId: LaneId;
      /** 実体の絶対パス */
      readonly path: AbsolutePath;
      /** レーンルートからの相対パス */
      readonly relativePath: string;
    };

/** 横断検索バックエンドの結果 */
export type LaneSearchOutcome =
  | {
      /** 結果あり */
      readonly kind: 'results';
      /** ヒット列 */
      readonly results: readonly LaneSearchResult[];
      /** 上限到達で切詰めた場合 true */
      readonly truncated: boolean;
    }
  | {
      /** バックエンド不在 */
      readonly kind: 'unavailable';
    };
