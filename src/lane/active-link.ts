import type { AbsolutePath } from '../foundation/model';
import type { ActiveLinkSwapPlan } from '../workspace/model';
import type { WorkspaceLinkPort } from '../workspace/ports';

/**
 * 切替計画の純粋生成
 * @param linkPath - symlink 絶対パス
 * @param from - 切替前の参照先
 * @param to - 切替後の参照先
 * @returns 切替計画、または同一参照先で undefined
 */
export const planActiveLinkSwap = (
  linkPath: AbsolutePath,
  from: AbsolutePath | undefined,
  to: AbsolutePath,
): ActiveLinkSwapPlan | undefined => {
  if (from === to) return undefined;
  return { linkPath, from, to };
};

/**
 * 切替計画の実行
 * @param plan - 切替計画
 * @param link - symlink 操作ポート
 */
export const executeActiveLinkSwap = (plan: ActiveLinkSwapPlan, link: WorkspaceLinkPort): void => {
  link.swap(plan.to);
};
