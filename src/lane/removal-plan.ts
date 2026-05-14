import type { LaneId } from '../foundation/model';
import type { Lane, LaneCatalog } from './model';

/** 削除計画 */
export type LaneRemovalPlan =
  | {
      /** 操作不要 */
      readonly kind: 'noop';
      /** 不要理由 */
      readonly reason: 'no-target';
    }
  | {
      /** 実行阻害 */
      readonly kind: 'blocked';
      /** 阻害理由 */
      readonly reason: 'active-lane';
    }
  | {
      /** 削除実行 */
      readonly kind: 'remove';
      /** 削除対象 */
      readonly target: Lane;
    };

/** 削除計画入力 */
export interface LaneRemovalInput {
  /** 対象レーン識別子 */
  readonly targetId: LaneId;
  /** 活性レーン識別子 */
  readonly activeLaneId: LaneId | undefined;
  /** 評価時点のカタログ */
  readonly catalog: LaneCatalog;
}

/**
 * 削除入力からの計画生成
 * @param input - 計画入力
 * @returns 計画 ADT
 */
export const planLaneRemoval = (input: LaneRemovalInput): LaneRemovalPlan => {
  const { targetId, activeLaneId, catalog } = input;
  const target = catalog.byId.get(targetId);
  if (!target) return { kind: 'noop', reason: 'no-target' };
  if (target.id === activeLaneId) return { kind: 'blocked', reason: 'active-lane' };
  return { kind: 'remove', target };
};
