import type { LaneQuery } from './model';

/**
 * 生入力からの検索クエリ検証
 * @param raw - InputBox の生入力、または未入力で undefined
 * @returns 前後空白を除いた非空クエリ、空なら undefined
 */
export const parseLaneQuery = (raw: string | undefined): LaneQuery | undefined => {
  const trimmed = (raw ?? '').trim();
  return trimmed.length === 0 ? undefined : (trimmed as LaneQuery);
};
