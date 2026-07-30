import type { LaneId } from '../foundation/model';
import type { Lane, LaneCatalog } from './model';

/** リネーム計画 */
export type LaneRenamePlan =
  | {
      /** 操作不要 */
      readonly kind: 'noop';
      /** 不要理由 */
      readonly reason: 'same-name' | 'no-target';
    }
  | {
      /** 入力不正 */
      readonly kind: 'invalid';
      /** 不正理由 */
      readonly reason: 'empty';
    }
  | {
      /** 改名実行 */
      readonly kind: 'rename';
      /** 改名前レーン */
      readonly from: Lane;
      /** 改名後の識別と表示名 */
      readonly to: { readonly id: LaneId; readonly label: string };
    };

/** リネーム計画入力 */
export interface LaneRenameInput {
  /** 対象レーン識別子 */
  readonly targetId: LaneId;
  /** 入力された新ラベルの trim 前生文字列 */
  readonly newLabel: string;
  /** 評価時点のカタログ */
  readonly catalog: LaneCatalog;
}

/**
 * リネーム入力からの計画生成
 * @param input - 計画入力
 * @returns 計画 ADT
 */
export const planLaneRename = (input: LaneRenameInput): LaneRenamePlan => {
  const { targetId, newLabel, catalog } = input;
  const target = catalog.byId.get(targetId);
  if (!target) return { kind: 'noop', reason: 'no-target' };

  const trimmed = newLabel.trim();
  if (trimmed.length === 0) return { kind: 'invalid', reason: 'empty' };
  if (trimmed === target.label) return { kind: 'noop', reason: 'same-name' };

  return {
    kind: 'rename',
    from: target,
    to: { id: target.id, label: trimmed },
  };
};
