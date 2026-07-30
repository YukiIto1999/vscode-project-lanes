import type { AbsolutePath, LaneId } from '../foundation/model';
import { planActiveLinkSwap } from '../lane/active-link';
import type { Lane, LaneCatalog } from '../lane/model';
import type { ActiveLinkSwapPlan } from './model';

/** アクティブレーン再整合の入力 */
export interface ActiveLaneReconciliationInput {
  /** 評価時点のカタログ */
  readonly catalog: LaneCatalog;
  /** symlink 自身の絶対パス */
  readonly linkPath: AbsolutePath;
  /** 評価時点の symlink 参照先 */
  readonly currentLinkTarget: AbsolutePath | undefined;
  /** 永続化済み選択レーン識別子 */
  readonly cachedLaneId: LaneId | undefined;
}

/** アクティブレーン再整合の純粋計画 */
export type ActiveLaneReconciliationPlan =
  | {
      /** カタログが空で操作不要 */
      readonly kind: 'empty';
    }
  | {
      /** レーン活性化 */
      readonly kind: 'activate';
      /** 活性化対象 */
      readonly lane: Lane;
      /** 必要な symlink 入替 */
      readonly linkSwap: ActiveLinkSwapPlan | undefined;
      /** 保存が必要な選択 cache 更新、または更新不要 */
      readonly selectionUpdate: { readonly laneId: LaneId } | undefined;
    };

/**
 * catalog 内の symlink 参照先、catalog 内の選択 cache、catalog 先頭の順で再整合する
 * @param input - 再整合入力
 * @returns 副作用の実行計画
 */
export const planActiveLaneReconciliation = (
  input: ActiveLaneReconciliationInput,
): ActiveLaneReconciliationPlan => {
  const { catalog, linkPath, currentLinkTarget, cachedLaneId } = input;
  const [firstLane] = catalog.lanes;
  if (!firstLane) return { kind: 'empty' };

  const linkedLane = currentLinkTarget
    ? catalog.lanes.find((lane) => lane.rootPath === currentLinkTarget)
    : undefined;
  const cachedLane = cachedLaneId ? catalog.byId.get(cachedLaneId) : undefined;
  const lane = linkedLane ?? cachedLane ?? firstLane;

  return {
    kind: 'activate',
    lane,
    linkSwap: planActiveLinkSwap(linkPath, currentLinkTarget, lane.rootPath),
    selectionUpdate: cachedLaneId === lane.id ? undefined : { laneId: lane.id },
  };
};
