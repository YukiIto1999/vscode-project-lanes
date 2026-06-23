import type { AbsolutePath } from '../foundation/model';
import type { LaneQuery, LaneRoot, LaneSearchOutcome, LaneSearchResult } from './model';

/** 横断検索バックエンドのポート */
export interface LaneSearchPort {
  /**
   * ファイル内文字列検索
   * @param query - 検証済みクエリ
   * @param roots - 検索対象レーンルート列
   * @returns 検索結果
   */
  readonly searchContent: (
    query: LaneQuery,
    roots: readonly LaneRoot[],
  ) => Promise<LaneSearchOutcome>;
  /**
   * ファイル列挙
   * @param roots - 検索対象レーンルート列
   * @returns ファイル列挙結果
   */
  readonly listFiles: (roots: readonly LaneRoot[]) => Promise<LaneSearchOutcome>;
}

/** 横断検索の対話ポート */
export interface SearchUiPort {
  /**
   * クエリ入力ダイアログ
   * @returns 生入力、または取消で undefined
   */
  readonly promptQuery: () => Promise<string | undefined>;
  /**
   * content 結果の選択ダイアログ
   * @param results - ヒット列
   * @param truncated - 上限到達フラグ
   * @returns 選択結果、または取消で undefined
   */
  readonly pickContentResult: (
    results: readonly LaneSearchResult[],
    truncated: boolean,
  ) => Promise<LaneSearchResult | undefined>;
  /**
   * file 結果の選択ダイアログ
   * @param results - ファイルヒット列
   * @returns 選択結果、または取消で undefined
   */
  readonly pickFileResult: (
    results: readonly LaneSearchResult[],
  ) => Promise<LaneSearchResult | undefined>;
  /** 結果 0 件の通知 */
  readonly notifyEmpty: () => void;
  /** バックエンド不在の警告 */
  readonly warnUnavailable: () => void;
}

/** ファイルを開くポート */
export interface FileOpenPort {
  /**
   * 指定位置でのファイルオープン
   * @param path - 実体の絶対パス
   * @param position - カーソル位置、1 始まり。未指定で先頭
   * @returns オープン完了の Promise
   */
  readonly openAt: (
    path: AbsolutePath,
    position?: { readonly line: number; readonly column: number },
  ) => Promise<void>;
}
