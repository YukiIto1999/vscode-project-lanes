import type { AbsolutePath, LaneId, WorkspaceKey } from '../foundation/model';
import type { OperationQueue } from '../foundation/operation-queue';
import { parentDirectory, uriToAbsolutePath } from '../foundation/path';
import type { LaneRootAvailabilityPort, WorkspaceLinkPort } from '../workspace/ports';
import type { WorkspaceCatalogRegistry } from '../workspace/registry';
import { planActiveLaneReconciliation } from '../workspace/active-lane-reconciliation';
import { createLaneFocusTransaction } from './focus-transaction';
import type { Lane, LaneCatalog, LaneFocusPlan, LaneServiceSnapshot } from './model';
import type {
  EditorSnapshotStorePort,
  EditorPort,
  LanePromptPort,
  LaneSelectionStorePort,
  LaneTerminalPort,
  LaneViewRebindPort,
} from './ports';
import { planLaneRelocation, type LaneRelocationPlan } from './relocation-plan';
import { planLaneRemoval } from './removal-plan';
import { planLaneRename } from './rename-plan';

/** レーンサービスの依存 */
export interface LaneServiceDeps {
  /** カタログ取得関数 */
  readonly getCatalog: () => LaneCatalog;
  /** ワークスペース永続キー */
  readonly workspaceKey: WorkspaceKey;
  /** エディタ操作ポート */
  readonly editor: EditorPort;
  /** symlink 操作ポート */
  readonly link: WorkspaceLinkPort;
  /** new link 未作成時に限って利用する旧 link target の読取 */
  readonly readLegacyLinkTarget: () => AbsolutePath | undefined;
  /** ターミナル切替ポート */
  readonly terminal: LaneTerminalPort;
  /** ビュー再走査ポート */
  readonly viewRebind: LaneViewRebindPort;
  /** 選択永続化ポート */
  readonly selectionStore: LaneSelectionStorePort;
  /** ユーザー対話ポート */
  readonly prompt: LanePromptPort;
  /** カタログ正本の操作 */
  readonly registry: WorkspaceCatalogRegistry;
  /** エディタ snapshot ストア */
  readonly editorStore: EditorSnapshotStorePort;
  /** runtime 共通の非同期操作 queue */
  readonly operationQueue: OperationQueue;
  /** レーンルート利用可否の検査 */
  readonly rootAvailability: LaneRootAvailabilityPort;
}

/** アクティブレーン再整合の結果 */
export type ActiveLaneReconciliationResult =
  | {
      /** active lane を持たない状態 */
      readonly kind: 'empty' | 'inactive';
      /** selection cache を消去済み */
      readonly cache: 'saved';
    }
  | {
      /** active lane を持たない状態 */
      readonly kind: 'empty' | 'inactive';
      /** selection cache の消去は次回再試行が必要 */
      readonly cache: 'pending';
      readonly error: unknown;
    }
  | {
      /** レーンを確定し cache も整合済み */
      readonly kind: 'active';
      readonly cache: 'saved';
    }
  | {
      /** レーンは確定したが cache 保存は次回再試行が必要 */
      readonly kind: 'active';
      readonly cache: 'pending';
      readonly error: unknown;
    };

/** active lane 再整合の commit 前失敗理由 */
export type ActiveLaneReconciliationFailureReason =
  | 'link-clear-failed'
  | 'link-swap-failed'
  | 'workspace-folder-mutation-rejected'
  | 'rollback-failed';

/** active lane 再整合の commit 前失敗 */
export class ActiveLaneReconciliationError extends Error {
  /** 失敗理由 */
  readonly reason: ActiveLaneReconciliationFailureReason;

  /**
   * commit 前失敗の生成
   * @param reason - 失敗理由
   * @param cause - 原因
   */
  constructor(reason: ActiveLaneReconciliationFailureReason, cause: unknown) {
    super(`Active lane reconciliation failed: ${reason}`, { cause });
    this.name = 'ActiveLaneReconciliationError';
    this.reason = reason;
  }
}

/** レーンサービスの操作インターフェース */
export interface LaneService {
  /**
   * symlink、selection cache、catalog を runtime 共通 queue 上で再整合
   * @returns レーン確定と cache 保存の状態
   */
  readonly reconcileActiveLane: () => Promise<ActiveLaneReconciliationResult>;
  /** 共通 queue 内で commit 後の未完了処理を再試行 */
  readonly finalizePendingOperations: () => Promise<void>;
  /**
   * レーンへのフォーカス
   * @param laneId - 切替先レーン識別子、または未指定で対話選択
   * @returns 判定結果
   */
  readonly focus: (laneId?: LaneId) => Promise<LaneFocusPlan>;
  /**
   * 活性レーンのターミナル全終了
   * @returns 完了の Promise
   */
  readonly closeActiveLaneTerminals: () => Promise<void>;
  /**
   * レーン名の変更
   * @param laneId - 対象レーン識別子、または未指定で対話選択
   * @returns 完了の Promise
   */
  readonly renameLane: (laneId?: LaneId) => Promise<void>;
  /**
   * レーンルートの所在変更
   * @param laneId - 対象レーン識別子、または未指定で対話選択
   * @returns 判定結果、または対話取消で undefined
   */
  readonly relocateLane: (laneId?: LaneId) => Promise<LaneRelocationPlan | undefined>;
  /**
   * レーンの削除
   * @param laneId - 対象レーン識別子、または未指定で対話選択
   * @returns 完了の Promise
   */
  readonly removeLane: (laneId?: LaneId) => Promise<void>;
  /**
   * 現在状態の取得
   * @returns 現状スナップショット
   */
  readonly snapshot: () => LaneServiceSnapshot;
}

interface PendingRenameFinalization {
  readonly target: Lane;
  readonly viewRebound: boolean;
}

interface PendingRemovalFinalization {
  /** 削除対象レーン識別子 */
  readonly laneId: LaneId;
  /** ターミナル終了の完了状態 */
  readonly terminalClosed: boolean;
  /** エディタ状態除外の永続化完了状態 */
  readonly snapshotRemoved: boolean;
}

/**
 * レーンサービスの生成
 * @param deps - 依存
 * @returns サービスインスタンス
 */
export const createLaneService = (deps: LaneServiceDeps): LaneService => {
  const {
    getCatalog,
    workspaceKey,
    editor,
    link,
    readLegacyLinkTarget,
    terminal,
    viewRebind,
    selectionStore,
    prompt,
    registry,
    editorStore,
    operationQueue,
    rootAvailability,
  } = deps;
  let activeLaneId: LaneId | undefined;
  let pendingRename: PendingRenameFinalization | undefined;
  let pendingRemoval: PendingRemovalFinalization | undefined;

  const focusTransaction = createLaneFocusTransaction({
    getCatalog,
    workspaceKey,
    editor,
    editorStore,
    link,
    viewRebind,
    selectionStore,
    terminal,
    rootAvailability,
    commitActiveLane: (laneId) => {
      activeLaneId = laneId;
    },
  });

  const finalizePendingRename = async (): Promise<void> => {
    let current = pendingRename;
    if (!current) return;

    if (!current.viewRebound) {
      const rebound = await viewRebind.rebindActiveFolder(current.target);
      if (!rebound) throw new Error('workspace-folder-mutation-rejected');
      current = { ...current, viewRebound: true };
      pendingRename = current;
    }

    pendingRename = undefined;
  };

  const finalizePendingRemoval = async (): Promise<void> => {
    let current = pendingRemoval;
    if (!current) return;

    const failures: unknown[] = [];
    if (!current.terminalClosed) {
      try {
        await terminal.closeLane(current.laneId);
        current = { ...current, terminalClosed: true };
        pendingRemoval = current;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!current.snapshotRemoved) {
      try {
        await editorStore.remove(current.laneId);
        current = { ...current, snapshotRemoved: true };
        pendingRemoval = current;
      } catch (error) {
        failures.push(error);
      }
    }

    if (current.terminalClosed && current.snapshotRemoved) pendingRemoval = undefined;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Lane removal finalization failed.');
    }
  };

  const finalizePendingOperations = async (): Promise<void> => {
    await focusTransaction.finalizePending();
    await finalizePendingRename();
    await finalizePendingRemoval();
  };

  const executeActiveLaneReconciliation = async (
    preferredLaneId?: LaneId,
  ): Promise<ActiveLaneReconciliationResult> => {
    await finalizePendingOperations();

    const catalog = getCatalog();
    const currentLinkTarget = link.readTarget();
    const legacyLinkTarget = currentLinkTarget === undefined ? readLegacyLinkTarget() : undefined;
    const cachedSelection = selectionStore.load(workspaceKey);
    const availabilityByLaneId = new Map(
      catalog.lanes.map((lane) => [lane.id, rootAvailability.inspect(lane.rootPath)]),
    );
    const linkedLane = catalog.lanes.find((lane) => lane.rootPath === currentLinkTarget);
    const linkedLaneUnavailable =
      linkedLane !== undefined && availabilityByLaneId.get(linkedLane.id) !== 'available';
    const plan = planActiveLaneReconciliation({
      catalog,
      linkPath: link.linkPath,
      currentLinkTarget,
      ...(legacyLinkTarget !== undefined ? { legacyLinkTarget } : {}),
      cachedSelection,
      ...(preferredLaneId ? { preferredLaneId } : {}),
      availabilityByLaneId,
    });

    const preserveLinkedLane = async (): Promise<ActiveLaneReconciliationResult> => {
      if (!linkedLane) throw new Error('linked-lane-missing');
      activeLaneId = linkedLane.id;
      if (cachedSelection?.kind === 'v2' && cachedSelection.laneId === linkedLane.id) {
        return { kind: 'active', cache: 'saved' };
      }
      try {
        await selectionStore.save(workspaceKey, linkedLane.id);
        return { kind: 'active', cache: 'saved' };
      } catch (error) {
        return { kind: 'active', cache: 'pending', error };
      }
    };

    if (linkedLaneUnavailable && plan.kind === 'activate' && plan.lane.id !== linkedLane.id) {
      activeLaneId = linkedLane.id;
      const transition = await focusTransaction.focus(plan.lane.id);
      if (transition.kind === 'focus') return { kind: 'active', cache: 'saved' };
      if (transition.kind === 'blocked' && transition.reason === 'dirty-editors') {
        prompt.warnDirtyEditors();
        return preserveLinkedLane();
      }
      if (transition.kind === 'failed') {
        if (activeLaneId === plan.lane.id && link.readTarget() === plan.lane.rootPath) {
          return { kind: 'active', cache: 'pending', error: transition.error };
        }
        const preserved = await preserveLinkedLane();
        const cause =
          preserved.cache === 'pending'
            ? new AggregateError(
                [transition.error, preserved.error],
                'Active lane evacuation and cache rollback failed.',
              )
            : transition.error;
        throw new ActiveLaneReconciliationError('workspace-folder-mutation-rejected', cause);
      }
      return preserveLinkedLane();
    }

    if (linkedLaneUnavailable && (plan.kind === 'empty' || plan.kind === 'inactive')) {
      activeLaneId = linkedLane.id;
      if (editor.hasDirtyEditors()) {
        prompt.warnDirtyEditors();
        return preserveLinkedLane();
      }
    }

    if (plan.kind === 'empty' || plan.kind === 'inactive') {
      try {
        link.clear();
      } catch (error) {
        throw new ActiveLaneReconciliationError('link-clear-failed', error);
      }
      activeLaneId = undefined;
      if (cachedSelection !== undefined) {
        try {
          await selectionStore.save(workspaceKey, undefined);
        } catch (error) {
          return { kind: plan.kind, cache: 'pending', error };
        }
      }
      return { kind: plan.kind, cache: 'saved' };
    }

    let swapped = false;
    if (plan.linkSwap) {
      try {
        link.swap(plan.linkSwap.to);
        swapped = true;
      } catch (error) {
        throw new ActiveLaneReconciliationError('link-swap-failed', error);
      }
    }

    try {
      const rebound = await viewRebind.rebindActiveFolder(plan.lane);
      if (!rebound) throw new Error('workspace-folder-mutation-rejected');
    } catch (error) {
      if (swapped) {
        try {
          if (currentLinkTarget !== undefined) link.swap(currentLinkTarget);
          else link.clear();
        } catch (rollbackError) {
          throw new ActiveLaneReconciliationError(
            'rollback-failed',
            new AggregateError(
              [error, rollbackError],
              'Active lane reconciliation and link rollback failed.',
            ),
          );
        }
      }
      throw new ActiveLaneReconciliationError('workspace-folder-mutation-rejected', error);
    }

    activeLaneId = plan.lane.id;
    if (plan.selectionUpdate) {
      try {
        await selectionStore.save(workspaceKey, plan.selectionUpdate.laneId);
      } catch (error) {
        return { kind: 'active', cache: 'pending', error };
      }
    }
    return { kind: 'active', cache: 'saved' };
  };

  const reconcileActiveLane = (): Promise<ActiveLaneReconciliationResult> =>
    operationQueue.enqueue(executeActiveLaneReconciliation);

  return {
    reconcileActiveLane,
    finalizePendingOperations,

    focus: async (laneId) => {
      const targetId = laneId ?? (await prompt.pickLane(getCatalog().lanes));
      if (!targetId) return { kind: 'noop', reason: 'no-target' };

      return operationQueue.enqueue(async () => {
        try {
          await finalizePendingOperations();
        } catch (error) {
          return { kind: 'failed', reason: 'transition-failed', error };
        }
        const result = await focusTransaction.focus(targetId);
        if (result.kind === 'blocked' && result.reason === 'dirty-editors') {
          prompt.warnDirtyEditors();
        }
        return result;
      });
    },

    closeActiveLaneTerminals: async () => {
      if (activeLaneId) await terminal.closeLane(activeLaneId);
    },

    relocateLane: async (laneId) => {
      const initialCatalog = getCatalog();
      let targetId = laneId;
      if (!targetId) {
        const unavailableLanes = initialCatalog.lanes.filter(
          (lane) => rootAvailability.inspect(lane.rootPath) !== 'available',
        );
        if (unavailableLanes.length === 0) return { kind: 'noop', reason: 'no-target' };
        targetId = await prompt.pickLane(unavailableLanes);
        if (!targetId) return undefined;
      }

      const initialTarget = initialCatalog.byId.get(targetId);
      if (!initialTarget) return { kind: 'noop', reason: 'no-target' };
      if (rootAvailability.inspect(initialTarget.rootPath) === 'available') {
        return { kind: 'noop', reason: 'no-target' };
      }

      const replacementUri = await prompt.pickReplacementFolder(
        parentDirectory(initialTarget.rootPath),
      );
      if (!replacementUri) return undefined;

      return operationQueue.enqueue(async () => {
        await finalizePendingOperations();
        const catalog = getCatalog();
        const target = catalog.byId.get(targetId);
        if (!target || rootAvailability.inspect(target.rootPath) === 'available') {
          return { kind: 'noop', reason: 'no-target' };
        }
        const replacementPath = uriToAbsolutePath(replacementUri);
        const plan = planLaneRelocation({
          target,
          replacementUri,
          replacementAvailability: rootAvailability.inspect(replacementPath),
          catalog,
        });
        if (plan.kind !== 'relocate') return plan;

        const relocationWasActive = link.readTarget() === plan.target.rootPath;
        if (relocationWasActive) {
          activeLaneId = plan.target.id;
          const relocatedTarget: Lane = {
            ...plan.target,
            rootUri: plan.replacementUri,
            rootPath: plan.replacementPath,
          };
          let catalogPublished = false;
          const transition = await focusTransaction.relocateActive(
            plan.target,
            relocatedTarget,
            async () => {
              let relocated = false;
              try {
                relocated = await registry.relocate(targetId, plan.replacementUri);
              } finally {
                catalogPublished = getCatalog().byId.get(targetId)?.rootUri === plan.replacementUri;
              }
              if (!relocated || !catalogPublished) {
                throw new Error('relocation-catalog-not-published');
              }
            },
            () => catalogPublished,
          );
          if (transition.kind === 'blocked') {
            if (transition.reason === 'dirty-editors') prompt.warnDirtyEditors();
            return transition;
          }
          if (transition.kind === 'failed') throw transition.error;
          return plan;
        }

        const relocated = await registry.relocate(targetId, plan.replacementUri);
        if (!relocated) return { kind: 'noop', reason: 'no-target' };
        const reconciliation = await executeActiveLaneReconciliation();
        if (reconciliation.cache === 'pending') throw reconciliation.error;
        return plan;
      });
    },

    renameLane: async (laneId) => {
      const targetId = laneId ?? (await prompt.pickLane(getCatalog().lanes));
      if (!targetId) return;
      const target = getCatalog().byId.get(targetId);
      if (!target) return;

      const validate = (raw: string): string | undefined => {
        const plan = planLaneRename({ targetId, newLabel: raw, catalog: getCatalog() });
        if (plan.kind === 'invalid' && plan.reason === 'empty') return 'Enter a name.';
        return undefined;
      };

      const raw = await prompt.promptRename(target.label, validate);
      if (raw === undefined) return;

      await operationQueue.enqueue(async () => {
        await finalizePendingOperations();
        const plan = planLaneRename({ targetId, newLabel: raw, catalog: getCatalog() });
        if (plan.kind !== 'rename') return;

        const renameWasActive = activeLaneId === plan.from.id;
        pendingRename = renameWasActive
          ? {
              target: { ...plan.from, label: plan.to.label },
              viewRebound: false,
            }
          : undefined;
        let catalogCommitted = false;
        try {
          const renamed = await registry.rename(
            plan.from.id,
            plan.to.label,
            renameWasActive
              ? async () => {
                  catalogCommitted = true;
                  await finalizePendingRename();
                }
              : undefined,
          );
          if (!renamed) pendingRename = undefined;
        } catch (error) {
          if (!catalogCommitted) pendingRename = undefined;
          throw error;
        }
      });
    },

    removeLane: async (laneId) => {
      const targetId = laneId ?? (await prompt.pickLane(getCatalog().lanes));
      if (!targetId) return;
      const target = getCatalog().byId.get(targetId);
      if (!target) return;

      const confirmed = await prompt.confirmRemoval(target);
      if (!confirmed) return;

      await operationQueue.enqueue(async () => {
        await finalizePendingOperations();
        const plan = planLaneRemoval({ targetId, activeLaneId, catalog: getCatalog() });
        if (plan.kind === 'noop') return;
        if (plan.kind === 'blocked') {
          prompt.warnActiveLaneRemoval();
          return;
        }

        await registry.remove(plan.target.id, async () => {
          pendingRemoval = {
            laneId: plan.target.id,
            terminalClosed: false,
            snapshotRemoved: false,
          };
          await finalizePendingRemoval();
        });
      });
    },

    snapshot: () => ({ catalog: getCatalog(), activeLaneId }),
  };
};
