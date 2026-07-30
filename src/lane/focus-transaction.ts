import type { LaneId, WorkspaceKey } from '../foundation/model';
import type { LaneRootAvailabilityPort, WorkspaceLinkPort } from '../workspace/ports';
import { planActiveLinkSwap } from './active-link';
import { planLaneFocus } from './focus-plan';
import type { Lane, LaneCatalog, LaneFocusPlan } from './model';
import type {
  EditorPort,
  LaneSelectionStorePort,
  LaneSessionStore,
  LaneTerminalPort,
  LaneViewRebindPort,
} from './ports';

/** focus transaction の依存 */
export interface LaneFocusTransactionDeps {
  /** カタログ取得関数 */
  readonly getCatalog: () => LaneCatalog;
  /** ワークスペース永続キー */
  readonly workspaceKey: WorkspaceKey;
  /** エディタ操作ポート */
  readonly editor: EditorPort;
  /** エディタ snapshot ストア */
  readonly editorStore: LaneSessionStore;
  /** symlink 操作ポート */
  readonly link: WorkspaceLinkPort;
  /** ビュー再走査ポート */
  readonly viewRebind: LaneViewRebindPort;
  /** 選択永続化ポート */
  readonly selectionStore: LaneSelectionStorePort;
  /** ターミナル切替ポート */
  readonly terminal: LaneTerminalPort;
  /** 切替先レーンルートの利用可否検査 */
  readonly rootAvailability: LaneRootAvailabilityPort;
  /** commit 済み active lane の反映 */
  readonly commitActiveLane: (laneId: LaneId) => void;
}

/** focus transaction */
export interface LaneFocusTransaction {
  /**
   * 対象レーンへの切替
   * @param targetLaneId - 切替先レーン識別子
   * @returns 切替結果
   */
  readonly focus: (targetLaneId: LaneId) => Promise<LaneFocusPlan>;
  /**
   * active lane の root 所在変更
   * @param source - 変更前レーン
   * @param target - 変更後レーン
   * @param commitCatalog - link と view の確定後に行う catalog 永続化
   * @param isCatalogCommitted - commit callback が失敗した場合の公開状態判定
   * @returns 切替結果
   */
  readonly relocateActive: (
    source: Lane,
    target: Lane,
    commitCatalog: () => Promise<void>,
    isCatalogCommitted?: () => boolean,
  ) => Promise<LaneFocusPlan>;
  /** commit 後に残った finalization の再試行 */
  readonly finalizePending: () => Promise<void>;
}

interface PendingFinalization {
  readonly target: Lane;
  readonly selectionSaved: boolean;
  readonly terminalRevealed: boolean;
  readonly targetSnapshotRestored: boolean;
}

const transitionFailed = (error: unknown): LaneFocusPlan => ({
  kind: 'failed',
  reason: 'transition-failed',
  error,
});

/**
 * focus transaction の生成
 * @param deps - transaction の依存
 * @returns focus transaction
 */
export const createLaneFocusTransaction = (
  deps: LaneFocusTransactionDeps,
): LaneFocusTransaction => {
  const {
    getCatalog,
    workspaceKey,
    editor,
    editorStore,
    link,
    viewRebind,
    selectionStore,
    terminal,
    rootAvailability,
    commitActiveLane,
  } = deps;
  let pending: PendingFinalization | undefined;

  const finalizePending = async (): Promise<void> => {
    let current = pending;
    if (!current) return;

    if (!current.selectionSaved) {
      await selectionStore.save(workspaceKey, current.target.id);
      current = { ...current, selectionSaved: true };
      pending = current;
    }
    if (!current.terminalRevealed) {
      await terminal.revealLane(current.target);
      current = { ...current, terminalRevealed: true };
      pending = current;
    }
    if (!current.targetSnapshotRestored) {
      const targetSnapshot = editorStore.get(current.target.id);
      if (targetSnapshot) await editor.restoreSnapshot(targetSnapshot);
      current = { ...current, targetSnapshotRestored: true };
      pending = current;
    }

    pending = undefined;
  };

  const rollbackPrepared = async (
    source: Lane,
    sourceSnapshot: ReturnType<EditorPort['captureSnapshot']>,
    swapAttempted: boolean,
  ): Promise<readonly unknown[]> => {
    const failures: unknown[] = [];
    if (swapAttempted) {
      try {
        link.swap(source.rootPath);
      } catch (error) {
        failures.push(error);
      }
      try {
        const rebound = await viewRebind.rebindActiveFolder(source);
        if (!rebound) failures.push(new Error('workspace-folder-rollback-rejected'));
      } catch (error) {
        failures.push(error);
      }
    }

    try {
      await editor.restoreSnapshot(sourceSnapshot);
    } catch (error) {
      failures.push(error);
    }
    return failures;
  };

  const executeTransition = async (
    source: Lane,
    target: Lane,
    commitPrepared?: () => Promise<void>,
    isPreparationCommitted?: () => boolean,
  ): Promise<LaneFocusPlan> => {
    let sourceSnapshot: ReturnType<EditorPort['captureSnapshot']> | undefined;
    let closeAttempted = false;
    let swapAttempted = false;
    try {
      sourceSnapshot = editor.captureSnapshot();
      editorStore.save(source.id, sourceSnapshot);
      closeAttempted = true;
      await editor.closeAll();

      const swap = planActiveLinkSwap(link.linkPath, source.rootPath, target.rootPath);
      if (swap) {
        swapAttempted = true;
        link.swap(swap.to);
      }

      const rebound = await viewRebind.rebindActiveFolder(target);
      if (!rebound) throw new Error('workspace-folder-mutation-rejected');
      if (commitPrepared) {
        try {
          await commitPrepared();
        } catch (error) {
          if (isPreparationCommitted?.() !== true) throw error;
        }
      }
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      if (sourceSnapshot && closeAttempted) {
        rollbackFailures.push(...(await rollbackPrepared(source, sourceSnapshot, swapAttempted)));
      }
      const failure =
        rollbackFailures.length === 0
          ? error
          : new AggregateError(
              [error, ...rollbackFailures],
              'Lane focus transition and rollback failed.',
            );
      return transitionFailed(failure);
    }

    pending = {
      target,
      selectionSaved: false,
      terminalRevealed: false,
      targetSnapshotRestored: false,
    };
    commitActiveLane(target.id);

    try {
      await finalizePending();
      return { kind: 'focus', from: source, to: target };
    } catch (error) {
      return transitionFailed(error);
    }
  };

  const focus = async (targetLaneId: LaneId): Promise<LaneFocusPlan> => {
    const catalog = getCatalog();
    const target = catalog.byId.get(targetLaneId);
    if (!target) return { kind: 'noop', reason: 'no-target' };

    const linkTarget = link.readTarget();
    const source = catalog.lanes.find((lane) => lane.rootPath === linkTarget);
    if (!source) return { kind: 'blocked', reason: 'reconciliation-required' };

    const targetAvailability = rootAvailability.inspect(target.rootPath);
    const hasDirtyEditors =
      targetAvailability === 'available' && source.id !== target.id
        ? editor.hasDirtyEditors()
        : false;
    const plan = planLaneFocus(source, target, targetAvailability, hasDirtyEditors);
    if (plan.kind !== 'focus') return plan;

    return executeTransition(source, target);
  };

  const relocateActive = async (
    source: Lane,
    target: Lane,
    commitCatalog: () => Promise<void>,
    isCatalogCommitted?: () => boolean,
  ): Promise<LaneFocusPlan> => {
    if (link.readTarget() !== source.rootPath) {
      return { kind: 'blocked', reason: 'reconciliation-required' };
    }
    if (rootAvailability.inspect(target.rootPath) !== 'available') {
      return { kind: 'blocked', reason: 'root-unavailable' };
    }
    if (editor.hasDirtyEditors()) {
      return { kind: 'blocked', reason: 'dirty-editors' };
    }

    return executeTransition(source, target, commitCatalog, isCatalogCommitted);
  };

  return { focus, relocateActive, finalizePending };
};
