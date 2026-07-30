import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';
import type { LaneRootAvailabilityPort, WorkspaceLinkPort } from '../workspace/ports';
import { createLaneFocusTransaction } from './focus-transaction';
import type { EditorSnapshot, Lane, LaneCatalog } from './model';
import type {
  EditorSnapshotStorePort,
  EditorPort,
  LaneSelectionStorePort,
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
const relocatedSourceLane: Lane = {
  ...sourceLane,
  rootUri: 'file:///moved/web' as UriString,
  rootPath: '/moved/web' as AbsolutePath,
};
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
  | 'close-false'
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
  saveSnapshot,
}: {
  readonly linkTarget?: AbsolutePath;
  readonly dirty?: boolean;
  readonly activeLaneId?: LaneId;
  readonly failures?: readonly FailureStep[];
  readonly rootAvailability?: ReturnType<LaneRootAvailabilityPort['inspect']>;
  readonly saveSnapshot?: EditorSnapshotStorePort['save'];
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
  let currentCatalog = catalog;
  let currentDirty = dirty;
  let currentRootAvailability = rootAvailability;

  const editor: EditorPort = {
    hasDirtyEditors: () => {
      events.push('validate:dirty');
      return currentDirty;
    },
    captureSnapshot: () => {
      events.push('source:capture');
      return sourceSnapshot;
    },
    closeAll: async () => {
      events.push('source:close');
      if (failing.has('close')) throw new Error('close failed');
      return !failing.has('close-false');
    },
    restoreSnapshot: async (snapshot) => {
      const source = snapshot === sourceSnapshot;
      events.push(source ? 'tabs:web' : 'tabs:api');
      if (source && failing.has('source-restore')) throw errors.sourceRestore;
      if (!source && failing.has('target-restore')) throw errors.targetRestore;
    },
  };
  const snapshots = new Map<LaneId, EditorSnapshot>([[targetLane.id, targetSnapshot]]);
  const editorStore: EditorSnapshotStorePort = {
    save: async (laneId, snapshot) => {
      events.push('source:save');
      await saveSnapshot?.(laneId, snapshot);
      snapshots.set(laneId, snapshot);
    },
    get: (laneId) => snapshots.get(laneId),
    remove: async () => {},
    prune: async () => 'unchanged',
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
      if (target !== sourceLane.rootPath && failing.has('swap')) throw errors.swap;
      currentLinkTarget = target;
    },
    clear: () => {
      currentLinkTarget = undefined;
    },
  };
  const viewRebind: LaneViewRebindPort = {
    rebindActiveFolder: async (activeLane) => {
      const source = activeLane.rootPath === sourceLane.rootPath;
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
    refreshLane: async () => {},
    closeLane: async () => {},
  };
  const availability: LaneRootAvailabilityPort = {
    inspect: () => {
      events.push('validate:root');
      return currentRootAvailability;
    },
  };
  const transaction = createLaneFocusTransaction({
    getCatalog: () => {
      events.push('validate:catalog');
      return currentCatalog;
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
    setCatalog: (next: LaneCatalog) => {
      currentCatalog = next;
    },
    setDirty: (next: boolean) => {
      currentDirty = next;
    },
    setLinkTarget: (next: AbsolutePath | undefined) => {
      currentLinkTarget = next;
    },
    setRootAvailability: (next: ReturnType<LaneRootAvailabilityPort['inspect']>) => {
      currentRootAvailability = next;
    },
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
      'validate:catalog',
      'validate:link',
      'validate:root',
      'validate:dirty',
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

  it('active root relocation は dirty editor があれば catalog commit 前に blocked を返す', async () => {
    const h = createHarness({ dirty: true });

    await expect(
      h.transaction.relocateActive(sourceLane, relocatedSourceLane, async () => {
        h.events.push('catalog:commit');
      }),
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'dirty-editors',
    });
    expect(h.events).toEqual(['validate:link', 'validate:root', 'validate:dirty']);
  });

  it('active root relocation は link と view の確定後に catalog を commit する', async () => {
    const h = createHarness();

    await expect(
      h.transaction.relocateActive(sourceLane, relocatedSourceLane, async () => {
        h.events.push('catalog:commit');
      }),
    ).resolves.toEqual({
      kind: 'focus',
      from: sourceLane,
      to: relocatedSourceLane,
    });
    expect(h.events).toEqual([
      'validate:link',
      'validate:root',
      'validate:dirty',
      'source:capture',
      'source:save',
      'validate:catalog',
      'validate:link',
      'validate:root',
      'validate:dirty',
      'source:close',
      'link:api',
      'view:api',
      'catalog:commit',
      'commit:web',
      'selection:web',
      'terminal:web',
      'tabs:web',
    ]);
    expect(h.currentActiveLaneId()).toBe(sourceLane.id);
    expect(h.currentLinkTarget()).toBe(relocatedSourceLane.rootPath);
  });

  it('active root relocation の catalog commit failure は source tabs を復元する', async () => {
    const h = createHarness();
    const failure = new Error('catalog commit failed');

    const result = await h.transaction.relocateActive(sourceLane, relocatedSourceLane, async () => {
      h.events.push('catalog:commit');
      throw failure;
    });

    expect(result).toEqual({
      kind: 'failed',
      reason: 'transition-failed',
      error: failure,
    });
    expect(h.events.slice(-6)).toEqual([
      'link:api',
      'view:api',
      'catalog:commit',
      'link:web',
      'view:web',
      'tabs:web',
    ]);
    expect(h.currentLinkTarget()).toBe(sourceLane.rootPath);
  });

  it('active root relocation の catalog publish 後 listener failure は target を確定する', async () => {
    const h = createHarness();
    const failure = new Error('catalog listener failed');
    let catalogPublished = false;

    const result = await h.transaction.relocateActive(
      sourceLane,
      relocatedSourceLane,
      async () => {
        catalogPublished = true;
        throw failure;
      },
      () => catalogPublished,
    );

    expect(result).toEqual({
      kind: 'focus',
      from: sourceLane,
      to: relocatedSourceLane,
    });
    expect(h.currentLinkTarget()).toBe(relocatedSourceLane.rootPath);
    expect(h.events).not.toContain('link:web');
  });

  it('active root relocation の tabs close failure は catalog を変更しない', async () => {
    const h = createHarness({ failures: ['close'] });

    await h.transaction.relocateActive(sourceLane, relocatedSourceLane, async () => {
      h.events.push('catalog:commit');
    });

    expect(h.events).not.toContain('catalog:commit');
  });

  it('active root relocation の link failure は source を復元して catalog を変更しない', async () => {
    const h = createHarness({ failures: ['swap'] });

    const result = await h.transaction.relocateActive(sourceLane, relocatedSourceLane, async () => {
      h.events.push('catalog:commit');
    });

    expect(result.kind).toBe('failed');
    expect(h.events).not.toContain('catalog:commit');
    expect(h.events.slice(-3)).toEqual(['link:web', 'view:web', 'tabs:web']);
    expect(h.currentLinkTarget()).toBe(sourceLane.rootPath);
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

  it('source snapshot の永続化完了前は tabs を閉じない', async () => {
    let resolveSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const h = createHarness({ saveSnapshot: () => savePending });

    const focusing = h.transaction.focus(targetLane.id);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.events).toContain('source:save');
    expect(h.events).not.toContain('source:close');

    resolveSave();
    await expect(focusing).resolves.toMatchObject({ kind: 'focus' });
    expect(h.events).toContain('source:close');
  });

  it('source snapshot の永続化失敗時は tabs と topology を変更しない', async () => {
    const failure = new Error('snapshot save failed');
    const h = createHarness({
      saveSnapshot: async () => {
        throw failure;
      },
    });

    await expect(h.transaction.focus(targetLane.id)).resolves.toEqual({
      kind: 'failed',
      reason: 'transition-failed',
      error: failure,
    });
    expect(h.events).not.toContain('source:close');
    expect(h.events).not.toContain('link:api');
    expect(h.events).not.toContain('tabs:web');
  });

  it('snapshot 保存待機中に dirty editor が生じたら close 前に blocked を返す', async () => {
    let resolveSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const h = createHarness({ saveSnapshot: () => savePending });

    const focusing = h.transaction.focus(targetLane.id);
    await Promise.resolve();
    await Promise.resolve();
    h.setDirty(true);
    resolveSave();

    await expect(focusing).resolves.toEqual({ kind: 'blocked', reason: 'dirty-editors' });
    expect(h.events).not.toContain('source:close');
  });

  it('snapshot 保存待機中に link topology が変わったら close 前に再整合を要求する', async () => {
    let resolveSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const h = createHarness({ saveSnapshot: () => savePending });

    const focusing = h.transaction.focus(targetLane.id);
    await Promise.resolve();
    await Promise.resolve();
    h.setLinkTarget(targetLane.rootPath);
    resolveSave();

    await expect(focusing).resolves.toEqual({
      kind: 'blocked',
      reason: 'reconciliation-required',
    });
    expect(h.events).not.toContain('source:close');
  });

  it('snapshot 保存待機中に catalog が変わったら close 前に再整合を要求する', async () => {
    let resolveSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const h = createHarness({ saveSnapshot: () => savePending });

    const focusing = h.transaction.focus(targetLane.id);
    await Promise.resolve();
    await Promise.resolve();
    h.setCatalog({
      lanes: [sourceLane],
      byId: new Map([[sourceLane.id, sourceLane]]),
    });
    resolveSave();

    await expect(focusing).resolves.toEqual({
      kind: 'blocked',
      reason: 'reconciliation-required',
    });
    expect(h.events).not.toContain('source:close');
  });

  it('snapshot 保存待機中に target root が利用不能になったら close 前に blocked を返す', async () => {
    let resolveSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const h = createHarness({ saveSnapshot: () => savePending });

    const focusing = h.transaction.focus(targetLane.id);
    await Promise.resolve();
    await Promise.resolve();
    h.setRootAvailability('missing');
    resolveSave();

    await expect(focusing).resolves.toEqual({ kind: 'blocked', reason: 'root-unavailable' });
    expect(h.events).not.toContain('source:close');
  });

  it('tabs close が false を返したら commit せず source tabs を復元する', async () => {
    const h = createHarness({ failures: ['close-false'] });

    const result = await h.transaction.focus(targetLane.id);

    expect(result.kind).toBe('failed');
    expect(h.events).toContain('tabs:web');
    expect(h.events).not.toContain('link:api');
    expect(h.events).not.toContain('commit:api');
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
