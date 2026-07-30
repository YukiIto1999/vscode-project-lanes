import type { LaneId, WorkspaceKey } from '../foundation/model';
import type { OperationQueue } from '../foundation/operation-queue';
import type { LaneRootAvailabilityPort, WorkspaceLinkPort } from '../workspace/ports';
import type { WorkspaceCatalogRegistry } from '../workspace/registry';
import { planActiveLaneReconciliation } from '../workspace/active-lane-reconciliation';
import { createLaneFocusTransaction } from './focus-transaction';
import type { Lane, LaneCatalog, LaneFocusPlan, LaneServiceSnapshot } from './model';
import type {
  EditorPort,
  LanePromptPort,
  LaneSelectionStorePort,
  LaneSessionStore,
  LaneTerminalPort,
  LaneViewRebindPort,
} from './ports';
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
  /** ターミナル rekey ポート */
  readonly terminalRekey: { readonly rekeyLane: (oldId: LaneId, newId: LaneId) => void };
  /** エディタ snapshot ストア */
  readonly editorStore: LaneSessionStore;
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
  readonly fromId: LaneId;
  readonly target: Lane;
  readonly terminalRekeyed: boolean;
  readonly editorRekeyed: boolean;
  readonly activeCommitted: boolean;
  readonly selectionSaved: boolean;
  readonly viewRebound: boolean;
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
    terminal,
    viewRebind,
    selectionStore,
    prompt,
    registry,
    terminalRekey,
    editorStore,
    operationQueue,
    rootAvailability,
  } = deps;
  let activeLaneId: LaneId | undefined;
  let pendingRename: PendingRenameFinalization | undefined;

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

    if (!current.terminalRekeyed) {
      terminalRekey.rekeyLane(current.fromId, current.target.id);
      current = { ...current, terminalRekeyed: true };
      pendingRename = current;
    }
    if (!current.editorRekeyed) {
      editorStore.rekey(current.fromId, current.target.id);
      current = { ...current, editorRekeyed: true };
      pendingRename = current;
    }
    if (!current.activeCommitted) {
      activeLaneId = current.target.id;
      current = { ...current, activeCommitted: true };
      pendingRename = current;
    }
    if (!current.selectionSaved) {
      await selectionStore.save(workspaceKey, current.target.id);
      current = { ...current, selectionSaved: true };
      pendingRename = current;
    }
    if (!current.viewRebound) {
      const rebound = await viewRebind.rebindActiveFolder(current.target);
      if (!rebound) throw new Error('workspace-folder-mutation-rejected');
      current = { ...current, viewRebound: true };
      pendingRename = current;
    }

    pendingRename = undefined;
  };

  const finalizePendingOperations = async (): Promise<void> => {
    await focusTransaction.finalizePending();
    await finalizePendingRename();
  };

  const reconcileActiveLane = (): Promise<ActiveLaneReconciliationResult> =>
    operationQueue.enqueue(async () => {
      await finalizePendingOperations();

      const catalog = getCatalog();
      const currentLinkTarget = link.readTarget();
      const cachedLaneId = selectionStore.load(workspaceKey);
      const plan = planActiveLaneReconciliation({
        catalog,
        linkPath: link.linkPath,
        currentLinkTarget,
        cachedLaneId,
        availabilityByLaneId: new Map(
          catalog.lanes.map((lane) => [lane.id, rootAvailability.inspect(lane.rootPath)]),
        ),
      });
      if (plan.kind === 'empty' || plan.kind === 'inactive') {
        try {
          link.clear();
        } catch (error) {
          throw new ActiveLaneReconciliationError('link-clear-failed', error);
        }
        activeLaneId = undefined;
        if (cachedLaneId !== undefined) {
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
    });

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

    renameLane: async (laneId) => {
      const targetId = laneId ?? (await prompt.pickLane(getCatalog().lanes));
      if (!targetId) return;
      const target = getCatalog().byId.get(targetId);
      if (!target) return;

      const validate = (raw: string): string | undefined => {
        const plan = planLaneRename({ targetId, newLabel: raw, catalog: getCatalog() });
        if (plan.kind === 'invalid' && plan.reason === 'empty') return 'Enter a name.';
        if (plan.kind === 'invalid' && plan.reason === 'duplicate')
          return 'A lane with this name already exists.';
        return undefined;
      };

      const raw = await prompt.promptRename(target.label, validate);
      if (raw === undefined) return;

      await operationQueue.enqueue(async () => {
        await finalizePendingOperations();
        const plan = planLaneRename({ targetId, newLabel: raw, catalog: getCatalog() });
        if (plan.kind !== 'rename') return;

        const renameWasActive = activeLaneId === plan.from.id;
        pendingRename = {
          fromId: plan.from.id,
          target: { ...plan.from, id: plan.to.id, label: plan.to.label },
          terminalRekeyed: false,
          editorRekeyed: false,
          activeCommitted: !renameWasActive,
          selectionSaved: !renameWasActive,
          viewRebound: !renameWasActive,
        };
        let catalogCommitted = false;
        try {
          const renamed = await registry.rename(plan.from.label, plan.to.label, async () => {
            catalogCommitted = true;
            await finalizePendingRename();
          });
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

        await registry.remove(plan.target.label, async () => {
          try {
            await terminal.closeLane(plan.target.id);
          } finally {
            editorStore.clear(plan.target.id);
          }
        });
      });
    },

    snapshot: () => ({ catalog: getCatalog(), activeLaneId }),
  };
};
