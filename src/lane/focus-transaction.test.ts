import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';
import type { LaneRootAvailabilityPort, WorkspaceLinkPort } from '../workspace/ports';
import { createLaneFocusTransaction } from './focus-transaction';
import type { EditorSnapshot, Lane, LaneCatalog } from './model';
import type {
  EditorPort,
  LaneSelectionStorePort,
  LaneSessionStore,
  LaneTerminalPort,
  LaneViewRebindPort,
} from './ports';

const workspaceKey = 'workspace:test' as WorkspaceKey;
const lane = (id: string): Lane => ({
  id: id as LaneId,
  label: id,
  rootUri: `file:///repo/${id}` as UriString,
  rootPath: `/repo/${id}` as AbsolutePath,
});

const sourceLane = lane('web');
const targetLane = lane('api');
const catalog: LaneCatalog = {
  lanes: [sourceLane, targetLane],
  byId: new Map([
    [sourceLane.id, sourceLane],
    [targetLane.id, targetLane],
  ]),
};
const sourceSnapshot: EditorSnapshot = {
  tabs: [{ uri: 'file:///repo/web/source.ts' as UriString, viewColumn: 1 }],
};
const targetSnapshot: EditorSnapshot = {
  tabs: [{ uri: 'file:///repo/api/target.ts' as UriString, viewColumn: 1 }],
};

type FailureStep =
  | 'close'
  | 'swap'
  | 'target-rebind-throw'
  | 'target-rebind-false'
  | 'source-swap'
  | 'source-rebind'
  | 'source-restore'
  | 'selection'
  | 'terminal'
  | 'target-restore';

const createHarness = ({
  linkTarget = sourceLane.rootPath,
  dirty = false,
  activeLaneId = sourceLane.id,
  failures = [],
  rootAvailability = 'available',
}: {
  readonly linkTarget?: AbsolutePath;
  readonly dirty?: boolean;
  readonly activeLaneId?: LaneId;
  readonly failures?: readonly FailureStep[];
  readonly rootAvailability?: ReturnType<LaneRootAvailabilityPort['inspect']>;
} = {}) => {
  const events: string[] = [];
  const failing = new Set(failures);
  const errors = {
    swap: new Error('swap failed'),
    targetRebind: new Error('target rebind failed'),
    sourceSwap: new Error('source swap failed'),
    sourceRebind: new Error('source rebind failed'),
    sourceRestore: new Error('source restore failed'),
    selection: new Error('selection failed'),
    terminal: new Error('terminal failed'),
    targetRestore: new Error('target restore failed'),
  };
  let currentLinkTarget: AbsolutePath | undefined = linkTarget;
  let currentActiveLaneId: LaneId | undefined = activeLaneId;

  const editor: EditorPort = {
    hasDirtyEditors: () => {
      events.push('validate:dirty');
      return dirty;
    },
    captureSnapshot: () => {
      events.push('source:capture');
      return sourceSnapshot;
    },
    closeAll: async () => {
      events.push('source:close');
      if (failing.has('close')) throw new Error('close failed');
    },
    restoreSnapshot: async (snapshot) => {
      const source = snapshot === sourceSnapshot;
      events.push(source ? 'tabs:web' : 'tabs:api');
      if (source && failing.has('source-restore')) throw errors.sourceRestore;
      if (!source && failing.has('target-restore')) throw errors.targetRestore;
    },
  };
  const editorStore: LaneSessionStore = {
    save: () => {
      events.push('source:save');
    },
    get: (laneId) => (laneId === targetLane.id ? targetSnapshot : undefined),
    rekey: () => {},
    clear: () => {},
  };
  const link: WorkspaceLinkPort = {
    linkPath: '/repo/.lanes-root/active' as AbsolutePath,
    readTarget: () => {
      events.push('validate:link');
      return currentLinkTarget;
    },
    swap: (target) => {
      events.push(target === sourceLane.rootPath ? 'link:web' : 'link:api');
      if (target === sourceLane.rootPath && failing.has('source-swap')) throw errors.sourceSwap;
      if (target === targetLane.rootPath && failing.has('swap')) throw errors.swap;
      currentLinkTarget = target;
    },
    clear: () => {
      currentLinkTarget = undefined;
    },
  };
  const viewRebind: LaneViewRebindPort = {
    rebindActiveFolder: async (activeLane) => {
      const source = activeLane.id === sourceLane.id;
      events.push(source ? 'view:web' : 'view:api');
      if (source && failing.has('source-rebind')) throw errors.sourceRebind;
      if (!source && failing.has('target-rebind-throw')) throw errors.targetRebind;
      return !(!source && failing.has('target-rebind-false'));
    },
  };
  const selectionStore: LaneSelectionStorePort = {
    load: () => sourceLane.id,
    save: async (_key, laneId) => {
      events.push(`selection:${laneId ?? 'none'}`);
      if (failing.has('selection')) throw errors.selection;
    },
  };
  const terminal: LaneTerminalPort = {
    revealLane: async (activeLane) => {
      events.push(`terminal:${activeLane.id}`);
      if (failing.has('terminal')) throw errors.terminal;
    },
    closeLane: async () => {},
  };
  const availability: LaneRootAvailabilityPort = {
    inspect: () => {
      events.push('validate:root');
      return rootAvailability;
    },
  };
  const transaction = createLaneFocusTransaction({
    getCatalog: () => {
      events.push('validate:catalog');
      return catalog;
    },
    workspaceKey,
    editor,
    editorStore,
    link,
    viewRebind,
    selectionStore,
    terminal,
    rootAvailability: availability,
    commitActiveLane: (laneId) => {
      events.push(`commit:${laneId}`);
      currentActiveLaneId = laneId;
    },
  });

  return {
    transaction,
    events,
    failing,
    errors,
    currentActiveLaneId: () => currentActiveLaneId,
    currentLinkTarget: () => currentLinkTarget,
  };
};

describe('createLaneFocusTransaction', () => {
  it('検証から target snapshot 復元まで commit point 順に実行する', async () => {
    const h = createHarness({ activeLaneId: targetLane.id });

    await expect(h.transaction.focus(targetLane.id)).resolves.toEqual({
      kind: 'focus',
      from: sourceLane,
      to: targetLane,
    });
    expect(h.events).toEqual([
      'validate:catalog',
      'validate:link',
      'validate:root',
      'validate:dirty',
      'source:capture',
      'source:save',
      'source:close',
      'link:api',
      'view:api',
      'commit:api',
      'selection:api',
      'terminal:api',
      'tabs:api',
    ]);
    expect(h.currentActiveLaneId()).toBe(targetLane.id);
    expect(h.currentLinkTarget()).toBe(targetLane.rootPath);
  });

  it('link target と一致する source が無ければ tabs を閉じず reconciliation を要求する', async () => {
    const h = createHarness({ linkTarget: '/repo/missing' as AbsolutePath });

    await expect(h.transaction.focus(targetLane.id)).resolves.toEqual({
      kind: 'blocked',
      reason: 'reconciliation-required',
    });
    expect(h.events).toEqual(['validate:catalog', 'validate:link']);
  });

  it('dirty editor があれば source snapshot を保存せず blocked を返す', async () => {
    const h = createHarness({ dirty: true });

    await expect(h.transaction.focus(targetLane.id)).resolves.toEqual({
      kind: 'blocked',
      reason: 'dirty-editors',
    });
    expect(h.events).toEqual([
      'validate:catalog',
      'validate:link',
      'validate:root',
      'validate:dirty',
    ]);
  });

  it('available な同一レーンなら dirty 判定を実行せず noop を返す', async () => {
    const h = createHarness({ dirty: true });

    await expect(h.transaction.focus(sourceLane.id)).resolves.toEqual({
      kind: 'noop',
      reason: 'same-lane',
    });
    expect(h.events).toEqual(['validate:catalog', 'validate:link', 'validate:root']);
  });

  it('同一レーンでも root が missing なら dirty 判定より先に blocked を返す', async () => {
    const h = createHarness({ dirty: true, rootAvailability: 'missing' });

    await expect(h.transaction.focus(sourceLane.id)).resolves.toEqual({
      kind: 'blocked',
      reason: 'root-unavailable',
    });
    expect(h.events).toEqual(['validate:catalog', 'validate:link', 'validate:root']);
  });

  it.each(['missing', 'inaccessible'] as const)(
    'target root が %s なら dirty 判定と tabs close より前に blocked を返す',
    async (rootAvailability) => {
      const h = createHarness({ dirty: true, rootAvailability });

      await expect(h.transaction.focus(targetLane.id)).resolves.toEqual({
        kind: 'blocked',
        reason: 'root-unavailable',
      });
      expect(h.events).toEqual(['validate:catalog', 'validate:link', 'validate:root']);
    },
  );

  it.each([
    ['link swap throw', 'swap'],
    ['target rebind throw', 'target-rebind-throw'],
    ['target rebind false', 'target-rebind-false'],
  ] as const)('%s は source link、view、tabs へ戻す', async (_label, failure) => {
    const h = createHarness({ failures: [failure] });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.reason).toBe('transition-failed');
    if (failure === 'swap') expect(result.error).toBe(h.errors.swap);
    if (failure === 'target-rebind-throw') expect(result.error).toBe(h.errors.targetRebind);
    if (failure === 'target-rebind-false') expect(result.error).toBeInstanceOf(Error);
    expect(h.events.slice(-3)).toEqual(['link:web', 'view:web', 'tabs:web']);
    expect(h.currentActiveLaneId()).toBe(sourceLane.id);
    expect(h.currentLinkTarget()).toBe(sourceLane.rootPath);
    expect(h.events).not.toContain('commit:api');
  });

  it('tabs close の失敗時は link と view を変更せず source tabs を復元する', async () => {
    const h = createHarness({ failures: ['close'] });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    expect(h.events).toContain('source:close');
    expect(h.events).toContain('tabs:web');
    expect(h.events).not.toContain('link:api');
    expect(h.events).not.toContain('view:api');
    expect(h.currentActiveLaneId()).toBe(sourceLane.id);
    expect(h.currentLinkTarget()).toBe(sourceLane.rootPath);
  });

  it('pre-commit failure は original error を結果に保持する', async () => {
    const h = createHarness({ failures: ['target-rebind-throw'] });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error).toBe(h.errors.targetRebind);
  });

  it('rollback view が失敗しても source tabs を復元する', async () => {
    const h = createHarness({
      failures: ['target-rebind-false', 'source-rebind'],
    });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error).toBeInstanceOf(AggregateError);
    expect((result.error as AggregateError).errors).toContain(h.errors.sourceRebind);
    expect(h.events.slice(-3)).toEqual(['link:web', 'view:web', 'tabs:web']);
  });

  it('rollback の link、view、tabs failure を original error と併合する', async () => {
    const h = createHarness({
      failures: ['target-rebind-false', 'source-swap', 'source-rebind', 'source-restore'],
    });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error).toBeInstanceOf(AggregateError);
    const failures = (result.error as AggregateError).errors;
    expect(failures).toHaveLength(4);
    expect(failures).toContain(h.errors.sourceSwap);
    expect(failures).toContain(h.errors.sourceRebind);
    expect(failures).toContain(h.errors.sourceRestore);
  });

  it('selection 保存失敗後は selection から finalization を再開する', async () => {
    const h = createHarness({ failures: ['selection'] });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error).toBe(h.errors.selection);
    expect(h.currentActiveLaneId()).toBe(targetLane.id);
    expect(h.events).not.toContain('link:web');

    h.failing.delete('selection');
    h.events.splice(0);
    await h.transaction.finalizePending();

    expect(h.events).toEqual(['selection:api', 'terminal:api', 'tabs:api']);
  });

  it('terminal 失敗後は terminal から finalization を再開する', async () => {
    const h = createHarness({ failures: ['terminal'] });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error).toBe(h.errors.terminal);
    expect(h.events).toContain('selection:api');
    expect(h.events).not.toContain('link:web');

    h.failing.delete('terminal');
    h.events.splice(0);
    await h.transaction.finalizePending();

    expect(h.events).toEqual(['terminal:api', 'tabs:api']);
  });

  it('target snapshot 復元失敗後は snapshot だけ再試行する', async () => {
    const h = createHarness({ failures: ['target-restore'] });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('unreachable');
    expect(result.error).toBe(h.errors.targetRestore);
    expect(h.events).toContain('selection:api');
    expect(h.events).toContain('terminal:api');
    expect(h.events).not.toContain('link:web');

    h.failing.delete('target-restore');
    h.events.splice(0);
    await h.transaction.finalizePending();

    expect(h.events).toEqual(['tabs:api']);
  });
});
