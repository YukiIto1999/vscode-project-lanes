import type { LaneId, WorkspaceKey } from '../foundation/model';
import type { WorkspaceLinkPort } from '../workspace/ports';
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

  const focus = async (targetLaneId: LaneId): Promise<LaneFocusPlan> => {
    const catalog = getCatalog();
    const target = catalog.byId.get(targetLaneId);
    if (!target) return { kind: 'noop', reason: 'no-target' };

    const linkTarget = link.readTarget();
    const source = catalog.lanes.find((lane) => lane.rootPath === linkTarget);
    if (!source) return { kind: 'blocked', reason: 'reconciliation-required' };

    const plan = planLaneFocus(source, target, editor.hasDirtyEditors());
    if (plan.kind !== 'focus') return plan;

    let sourceSnapshot: ReturnType<EditorPort['captureSnapshot']> | undefined;
    let closeAttempted = false;
    let swapAttempted = false;
    try {
      sourceSnapshot = editor.captureSnapshot();
      editorStore.save(source.id, sourceSnapshot);
      closeAttempted = true;
      await editor.closeAll();

      const swap = planActiveLinkSwap(link.linkPath, linkTarget, target.rootPath);
      if (swap) {
        swapAttempted = true;
        link.swap(swap.to);
      }

      const rebound = await viewRebind.rebindActiveFolder(target);
      if (!rebound) throw new Error('workspace-folder-mutation-rejected');
    } catch (error) {
      let failure = error;
      if (sourceSnapshot && closeAttempted) {
        const rollbackFailures = await rollbackPrepared(source, sourceSnapshot, swapAttempted);
        if (rollbackFailures.length > 0) {
          failure = new AggregateError(
            [error, ...rollbackFailures],
            'Lane focus transition and rollback failed.',
          );
        }
      }
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
      return plan;
    } catch (error) {
      return transitionFailed(error);
    }
  };

  return { focus, finalizePending };
};
