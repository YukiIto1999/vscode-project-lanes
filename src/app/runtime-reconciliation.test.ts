import { describe, expect, it } from 'vitest';
import type { LaneId } from '../foundation/model';
import { createOperationQueue } from '../foundation/operation-queue';
import { ActiveLaneReconciliationError } from '../lane/service';
import { createRuntimeReconciler } from './runtime-reconciliation';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('createRuntimeReconciler', () => {
  it('folder、active、pending 通知、terminal、render の順に実行する', async () => {
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => {
        events.push('folders');
        return { kind: 'collapsed' };
      },
      reconcileActiveLane: async () => {
        events.push('active');
        return {
          kind: 'active',
          cache: 'pending',
          error: new Error('cache failed'),
          activeLaneChanged: true,
          changedToLaneId: 'api' as LaneId,
        };
      },
      revealActiveLaneIfCurrent: async (laneId) => {
        events.push(`reveal:${laneId}`);
      },
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => {
        events.push('pending');
      },
      reportWorkspaceMutationRejected: async () => {
        events.push('warning');
      },
    });

    await reconciler.reconcile();

    expect(events).toEqual(['folders', 'active', 'pending', 'reveal:api', 'render']);
  });

  it('pending 通知中に別操作が切り替えた場合は古い active lane を再表示しない', async () => {
    const events: string[] = [];
    const operationQueue = createOperationQueue();
    const pendingStarted = deferred();
    const releasePending = deferred();
    let activeLaneId: LaneId | undefined = 'web' as LaneId;
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'noop' }),
      reconcileActiveLane: () =>
        operationQueue.enqueue(async () => {
          activeLaneId = 'api' as LaneId;
          return {
            kind: 'active',
            cache: 'pending',
            error: new Error('cache failed'),
            activeLaneChanged: true,
            changedToLaneId: 'api' as LaneId,
          };
        }),
      revealActiveLaneIfCurrent: (laneId) =>
        operationQueue.enqueue(async () => {
          if (activeLaneId === laneId) events.push(`reveal:${laneId}`);
        }),
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => {
        events.push('pending');
        pendingStarted.resolve();
        await releasePending.promise;
      },
      reportWorkspaceMutationRejected: async () => undefined,
    });

    const reconciling = reconciler.reconcile();
    await pendingStarted.promise;
    const focusing = operationQueue.enqueue(async () => {
      activeLaneId = 'web' as LaneId;
    });
    releasePending.resolve();
    await Promise.all([reconciling, focusing]);

    expect(events).toEqual(['pending', 'render']);
  });

  it('folder mutation の拒否を警告し active 再整合を始めない', async () => {
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'rejected' }),
      reconcileActiveLane: async () => {
        events.push('active');
        return { kind: 'empty', cache: 'saved', activeLaneChanged: false };
      },
      revealActiveLaneIfCurrent: async () => {
        events.push('reveal');
      },
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => {
        events.push('pending');
      },
      reportWorkspaceMutationRejected: async () => {
        events.push('warning');
      },
    });

    await reconciler.reconcile();

    expect(events).toEqual(['warning', 'render']);
  });

  it('folder executor の reject は render 後に caller へ伝播する', async () => {
    const failure = new Error('folder reconciliation failed');
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => Promise.reject(failure),
      reconcileActiveLane: async () => {
        events.push('active');
        return { kind: 'empty', cache: 'saved', activeLaneChanged: false };
      },
      revealActiveLaneIfCurrent: async () => {
        events.push('reveal');
      },
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => {
        events.push('pending');
      },
      reportWorkspaceMutationRejected: async () => {
        events.push('warning');
      },
    });

    await expect(reconciler.reconcile()).rejects.toBe(failure);
    expect(events).toEqual(['render']);
  });

  it('view mutation の precommit failure を専用警告へ対応づける', async () => {
    const events: string[] = [];
    const failure = new ActiveLaneReconciliationError(
      'workspace-folder-mutation-rejected',
      new Error('view failed'),
    );
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'noop' }),
      reconcileActiveLane: async () => Promise.reject(failure),
      revealActiveLaneIfCurrent: async () => {
        events.push('reveal');
      },
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => {
        events.push('pending');
      },
      reportWorkspaceMutationRejected: async (error) => {
        expect(error).toBe(failure);
        events.push('warning');
      },
    });

    await reconciler.reconcile();

    expect(events).toEqual(['warning', 'render']);
  });

  it('rollback failure を専用警告へ対応づける', async () => {
    const events: string[] = [];
    const failure = new ActiveLaneReconciliationError(
      'rollback-failed',
      new AggregateError([new Error('view'), new Error('rollback')]),
    );
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'noop' }),
      reconcileActiveLane: async () => Promise.reject(failure),
      revealActiveLaneIfCurrent: async () => undefined,
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => undefined,
      reportWorkspaceMutationRejected: async () => {
        events.push('warning');
      },
    });

    await reconciler.reconcile();

    expect(events).toEqual(['warning', 'render']);
  });

  it('link failure は render 後に caller へ伝播する', async () => {
    const failure = new ActiveLaneReconciliationError('link-swap-failed', new Error('swap failed'));
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'noop' }),
      reconcileActiveLane: async () => Promise.reject(failure),
      revealActiveLaneIfCurrent: async () => undefined,
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => undefined,
      reportWorkspaceMutationRejected: async () => {
        events.push('warning');
      },
    });

    await expect(reconciler.reconcile()).rejects.toBe(failure);
    expect(events).toEqual(['render']);
  });

  it('active lane が変わらなければ terminal を再表示せず render する', async () => {
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'noop' }),
      reconcileActiveLane: async () => ({
        kind: 'active',
        cache: 'saved',
        activeLaneChanged: false,
      }),
      revealActiveLaneIfCurrent: async () => {
        events.push('reveal');
      },
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => undefined,
      reportWorkspaceMutationRejected: async () => undefined,
    });

    await reconciler.reconcile();

    expect(events).toEqual(['render']);
  });

  it('folder event の待機中に完了した別操作の active lane を再表示しない', async () => {
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'noop' }),
      reconcileActiveLane: async () => ({
        kind: 'active',
        cache: 'saved',
        activeLaneChanged: false,
      }),
      revealActiveLaneIfCurrent: async () => {
        events.push('reveal');
      },
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => undefined,
      reportWorkspaceMutationRejected: async () => undefined,
    });

    await reconciler.reconcile();

    expect(events).toEqual(['render']);
  });

  it('inactive の pending cache を通知し terminal を再表示せず render する', async () => {
    const failure = new Error('selection clear failed');
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'noop' }),
      reconcileActiveLane: async () => {
        return {
          kind: 'inactive',
          cache: 'pending',
          error: failure,
          activeLaneChanged: true,
          changedToLaneId: undefined,
        };
      },
      revealActiveLaneIfCurrent: async () => {
        events.push('reveal');
      },
      render: () => {
        events.push('render');
      },
      reportPendingCache: async (error) => {
        expect(error).toBe(failure);
        events.push('pending');
      },
      reportWorkspaceMutationRejected: async () => undefined,
    });

    await reconciler.reconcile();

    expect(events).toEqual(['pending', 'render']);
  });

  it('active lane が unavailable なら terminal を表示せず render する', async () => {
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => {
        events.push('folders');
        return { kind: 'noop' };
      },
      reconcileActiveLane: async () => {
        events.push('active');
        return {
          kind: 'active',
          cache: 'saved',
          activeLaneChanged: true,
          changedToLaneId: 'api' as LaneId,
        };
      },
      revealActiveLaneIfCurrent: async () => undefined,
      render: () => {
        events.push('render');
      },
      reportPendingCache: async () => undefined,
      reportWorkspaceMutationRejected: async () => undefined,
    });

    await reconciler.reconcile();

    expect(events).toEqual(['folders', 'active', 'render']);
  });
});
