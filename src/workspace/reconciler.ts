import type { LaneId } from '../foundation/model';
import type { WorkspaceFolder } from './model';
import { isAnchor } from './scanner';

/** ユーザー操作による workspaceFolders 変化への応答アクション */
export type ReconciliationAction =
  | { readonly kind: 'noop' }
  /** unfocused 相当の変化: カタログ正本を rawFolders（アンカー除外）で置換 */
  | { readonly kind: 'replace'; readonly canonicalLanes: readonly WorkspaceFolder[] }
  /** focused 中の新規追加: カタログに吸収し、focus 状態を planFocusLane で復元 */
  | {
      readonly kind: 'absorb';
      readonly additions: readonly WorkspaceFolder[];
      readonly restoreFocusLaneId: LaneId;
    };

/** 照合入力 */
export interface ReconcileInput {
  readonly rawFolders: readonly WorkspaceFolder[];
  readonly currentLanes: readonly WorkspaceFolder[];
  readonly activeLaneId: LaneId | undefined;
}

/** ユーザー操作を解釈してアクションへ変換（純粋関数）
 *
 * 判断基準:
 *  - activeLaneId 無し → workspaceFolders が正本、差分があれば replace
 *  - activeLaneId 有り + 想定外のレーン追加 → absorb + focus 復元
 *  - activeLaneId 有り + 想定通り（[activeLane] のみ） → noop
 */
export const reconcileUserChange = (input: ReconcileInput): ReconciliationAction => {
  const nonAnchor = input.rawFolders.filter((f) => !isAnchor(f));

  if (!input.activeLaneId) {
    if (nonAnchor.length === input.currentLanes.length) {
      let same = true;
      for (let i = 0; i < nonAnchor.length; i++) {
        if (
          nonAnchor[i]!.uri !== input.currentLanes[i]!.uri ||
          nonAnchor[i]!.name !== input.currentLanes[i]!.name
        ) {
          same = false;
          break;
        }
      }
      if (same) return { kind: 'noop' };
    }
    return { kind: 'replace', canonicalLanes: nonAnchor };
  }

  const known = new Set(input.currentLanes.map((f) => f.name));
  const additions = nonAnchor.filter((f) => !known.has(f.name));
  if (additions.length === 0) return { kind: 'noop' };

  return {
    kind: 'absorb',
    additions,
    restoreFocusLaneId: input.activeLaneId,
  };
};
