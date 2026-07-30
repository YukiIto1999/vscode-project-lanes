import type { AbsolutePath, UriString } from '../foundation/model';
import { uriToAbsolutePath } from '../foundation/path';
import type { Lane, LaneCatalog, LaneFocusPlan, LaneRootAvailability } from './model';

/** レーン所在変更計画 */
export type LaneRelocationPlan =
  | {
      /** 操作不要 */
      readonly kind: 'noop';
      /** 不要理由 */
      readonly reason: 'no-target' | 'same-root';
    }
  | {
      /** 置換先の拒否 */
      readonly kind: 'rejected';
      /** 拒否理由 */
      readonly reason: 'replacement-unavailable' | 'duplicate-root';
    }
  | {
      /** active lane の所在変更を安全に実行できない状態 */
      readonly kind: 'blocked';
      /** focus transaction が返した阻害理由 */
      readonly reason: Extract<LaneFocusPlan, { readonly kind: 'blocked' }>['reason'];
    }
  | {
      /** 所在変更の実行 */
      readonly kind: 'relocate';
      /** 変更対象 */
      readonly target: Lane;
      /** 置換先 URI */
      readonly replacementUri: UriString;
      /** 置換先絶対パス */
      readonly replacementPath: AbsolutePath;
    };

/** レーン所在変更計画の入力 */
export interface LaneRelocationInput {
  /** 変更対象 */
  readonly target: Lane | undefined;
  /** 置換先 URI */
  readonly replacementUri: UriString;
  /** 置換先の現在の利用可否 */
  readonly replacementAvailability: LaneRootAvailability;
  /** 評価時点のカタログ */
  readonly catalog: LaneCatalog;
}

/**
 * レーン所在変更の純粋判定
 * @param input - 計画入力
 * @returns 計画 ADT
 */
export const planLaneRelocation = (input: LaneRelocationInput): LaneRelocationPlan => {
  const { target, replacementUri, replacementAvailability, catalog } = input;
  if (!target) return { kind: 'noop', reason: 'no-target' };

  const replacementPath = uriToAbsolutePath(replacementUri);
  if (replacementPath === target.rootPath) return { kind: 'noop', reason: 'same-root' };
  if (replacementAvailability !== 'available') {
    return { kind: 'rejected', reason: 'replacement-unavailable' };
  }

  const duplicated = catalog.lanes.some(
    (lane) => lane.id !== target.id && lane.rootPath === replacementPath,
  );
  if (duplicated) return { kind: 'rejected', reason: 'duplicate-root' };

  return { kind: 'relocate', target, replacementUri, replacementPath };
};
