import type { AbsolutePath, LaneId } from '../foundation/model';
import { planActiveLinkSwap } from '../lane/active-link';
import type { Lane, LaneCatalog, LaneRootAvailability } from '../lane/model';
import type { StoredLaneSelection } from '../lane/ports';
import type { ActiveLinkSwapPlan } from './model';

/** アクティブレーン再整合の入力 */
export interface ActiveLaneReconciliationInput {
  /** 評価時点のカタログ */
  readonly catalog: LaneCatalog;
  /** symlink 自身の絶対パス */
  readonly linkPath: AbsolutePath;
  /** 評価時点の symlink 参照先 */
  readonly currentLinkTarget: AbsolutePath | undefined;
  /** 新 link 未作成時だけ参照する旧 symlink 参照先 */
  readonly legacyLinkTarget?: AbsolutePath;
  /** 永続化済み選択 */
  readonly cachedSelection: StoredLaneSelection | undefined;
  /** 呼出操作が維持を要求するレーン識別子 */
  readonly preferredLaneId?: LaneId;
  /** 評価時点のレーン別 root 利用可否 */
  readonly availabilityByLaneId: ReadonlyMap<LaneId, LaneRootAvailability>;
}

/** アクティブレーン再整合の純粋計画 */
export type ActiveLaneReconciliationPlan =
  | {
      /** カタログが空で操作不要 */
      readonly kind: 'empty';
    }
  | {
      /** カタログ内の全レーンが利用不能 */
      readonly kind: 'inactive';
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
 * symlink 参照先が利用不能なら catalog 内の先頭の available lane へ退避する
 * link 未作成または catalog 外の場合だけ、available な選択 cache を補助に再整合する
 * @param input - 再整合入力
 * @returns 副作用の実行計画
 */
export const planActiveLaneReconciliation = (
  input: ActiveLaneReconciliationInput,
): ActiveLaneReconciliationPlan => {
  const {
    catalog,
    linkPath,
    currentLinkTarget,
    legacyLinkTarget,
    cachedSelection,
    preferredLaneId,
    availabilityByLaneId,
  } = input;
  if (catalog.lanes.length === 0) return { kind: 'empty' };
  const isAvailable = (lane: Lane): boolean => availabilityByLaneId.get(lane.id) === 'available';
  const firstAvailable = catalog.lanes.find(isAvailable);
  if (!firstAvailable) return { kind: 'inactive' };

  const linkedLane = currentLinkTarget
    ? catalog.lanes.find((lane) => lane.rootPath === currentLinkTarget)
    : undefined;
  const cachedLaneId =
    cachedSelection?.kind === 'v2'
      ? cachedSelection.laneId
      : cachedSelection?.kind === 'legacy'
        ? (() => {
            const matches = catalog.lanes.filter((lane) => lane.label === cachedSelection.label);
            return matches.length === 1 ? matches[0]!.id : undefined;
          })()
        : undefined;
  const cachedCandidate = cachedLaneId ? catalog.byId.get(cachedLaneId) : undefined;
  const cachedLane = cachedCandidate && isAvailable(cachedCandidate) ? cachedCandidate : undefined;
  const legacyCandidate =
    currentLinkTarget === undefined && legacyLinkTarget !== undefined
      ? catalog.lanes.find((lane) => lane.rootPath === legacyLinkTarget)
      : undefined;
  const legacyLane = legacyCandidate && isAvailable(legacyCandidate) ? legacyCandidate : undefined;
  const preferredCandidate = preferredLaneId ? catalog.byId.get(preferredLaneId) : undefined;
  const preferredLane =
    preferredCandidate && isAvailable(preferredCandidate) ? preferredCandidate : undefined;
  const lane =
    linkedLane && isAvailable(linkedLane)
      ? linkedLane
      : linkedLane
        ? firstAvailable
        : (preferredLane ?? cachedLane ?? legacyLane ?? firstAvailable);

  return {
    kind: 'activate',
    lane,
    linkSwap: planActiveLinkSwap(linkPath, currentLinkTarget, lane.rootPath),
    selectionUpdate:
      cachedSelection?.kind === 'v2' && cachedSelection.laneId === lane.id
        ? undefined
        : { laneId: lane.id },
  };
};
