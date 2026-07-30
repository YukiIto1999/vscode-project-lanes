import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane } from '../lane/model';
import { ActiveLaneReconciliationError } from '../lane/service';
import { createRuntimeReconciler } from './runtime-reconciliation';

const lane = (id: string): Lane => ({
  id: id as LaneId,
  label: id,
  rootUri: `file:///repo/${id}` as UriString,
  rootPath: `/repo/${id}` as AbsolutePath,
});

describe('createRuntimeReconciler', () => {
  it('folder、active、pending 通知、terminal、render の順に実行する', async () => {
    const events: string[] = [];
    let activeLaneId: LaneId | undefined = 'web' as LaneId;
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => {
        events.push('folders');
        return { kind: 'collapsed' };
      },
      reconcileActiveLane: async () => {
        events.push('active');
        activeLaneId = 'api' as LaneId;
        return { kind: 'active', cache: 'pending', error: new Error('cache failed') };
      },
      getActiveLaneId: () => activeLaneId,
      getLane: (laneId) => lane(laneId),
      revealLane: async (target) => {
        events.push(`reveal:${target.id}`);
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

  it('folder mutation の拒否を警告し active 再整合を始めない', async () => {
    const events: string[] = [];
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'rejected' }),
      reconcileActiveLane: async () => {
        events.push('active');
        return { kind: 'empty', cache: 'saved' };
      },
      getActiveLaneId: () => 'web' as LaneId,
      getLane: () => lane('web'),
      revealLane: async () => {
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
        return { kind: 'empty', cache: 'saved' };
      },
      getActiveLaneId: () => 'web' as LaneId,
      getLane: () => lane('web'),
      revealLane: async () => {
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
      getActiveLaneId: () => 'web' as LaneId,
      getLane: () => lane('web'),
      revealLane: async () => {
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
      getActiveLaneId: () => 'web' as LaneId,
      getLane: () => lane('web'),
      revealLane: async () => undefined,
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
      getActiveLaneId: () => 'web' as LaneId,
      getLane: () => lane('web'),
      revealLane: async () => undefined,
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
      reconcileActiveLane: async () => ({ kind: 'active', cache: 'saved' }),
      getActiveLaneId: () => 'web' as LaneId,
      getLane: () => lane('web'),
      revealLane: async () => {
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
    let activeLaneId: LaneId | undefined = 'web' as LaneId;
    const reconciler = createRuntimeReconciler({
      reconcileWorkspaceFolders: async () => ({ kind: 'noop' }),
      reconcileActiveLane: async () => {
        activeLaneId = undefined;
        return { kind: 'inactive', cache: 'pending', error: failure };
      },
      getActiveLaneId: () => activeLaneId,
      getLane: (laneId) => lane(laneId),
      revealLane: async () => {
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
});
