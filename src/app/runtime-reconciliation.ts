import type { LaneId } from '../foundation/model';
import {
  ActiveLaneReconciliationError,
  type ActiveLaneReconciliationResult,
} from '../lane/service';
import type { WorkspaceFolderReconciliationResult } from '../workspace/reconciler';

/** runtime 再整合の依存 */
export interface RuntimeReconcilerDeps {
  /** workspace folder の取込と縮退 */
  readonly reconcileWorkspaceFolders: () => Promise<WorkspaceFolderReconciliationResult>;
  /** active lane の再整合 */
  readonly reconcileActiveLane: () => Promise<ActiveLaneReconciliationResult>;
  /** 再整合時の変更先が現在も active なら terminal を表示 */
  readonly revealActiveLaneIfCurrent: (laneId: LaneId) => Promise<void>;
  /** UI の再描画 */
  readonly render: () => void;
  /** commit 後の cache 保存失敗通知 */
  readonly reportPendingCache: (error: unknown) => Promise<void>;
  /** workspace folder mutation 失敗通知 */
  readonly reportWorkspaceMutationRejected: (error?: unknown) => Promise<void>;
}

/** runtime 再整合 */
export interface RuntimeReconciler {
  /** workspace folders と active lane の順次再整合 */
  readonly reconcile: () => Promise<void>;
}

/**
 * workspace folder mutation に起因する active lane 再整合失敗か判定
 * @param error - 判定対象
 * @returns 専用警告の対象なら true
 */
export const isWorkspaceMutationReconciliationError = (
  error: unknown,
): error is ActiveLaneReconciliationError =>
  error instanceof ActiveLaneReconciliationError &&
  (error.reason === 'workspace-folder-mutation-rejected' || error.reason === 'rollback-failed');

/**
 * runtime 再整合の生成
 * @param deps - 再整合の依存
 * @returns workspace folder と active lane の orchestrator
 */
export const createRuntimeReconciler = (deps: RuntimeReconcilerDeps): RuntimeReconciler => {
  const {
    reconcileWorkspaceFolders,
    reconcileActiveLane,
    revealActiveLaneIfCurrent,
    render,
    reportPendingCache,
    reportWorkspaceMutationRejected,
  } = deps;

  return {
    reconcile: async () => {
      let activeLaneToReveal: LaneId | undefined;
      try {
        const workspaceResult = await reconcileWorkspaceFolders();
        if (workspaceResult.kind === 'rejected') {
          await reportWorkspaceMutationRejected();
          return;
        }

        try {
          const activeResult = await reconcileActiveLane();
          if (activeResult.activeLaneChanged && activeResult.changedToLaneId) {
            activeLaneToReveal = activeResult.changedToLaneId;
          }
          if (activeResult.cache === 'pending') {
            await reportPendingCache(activeResult.error);
          }
        } catch (error) {
          if (!isWorkspaceMutationReconciliationError(error)) throw error;
          await reportWorkspaceMutationRejected(error);
        }
      } finally {
        if (activeLaneToReveal) await revealActiveLaneIfCurrent(activeLaneToReveal);
        render();
      }
    },
  };
};
