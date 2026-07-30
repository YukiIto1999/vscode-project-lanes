import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';
import { createOperationQueue, type OperationQueue } from '../foundation/operation-queue';
import type { WorkspaceFolder } from '../workspace/model';
import type { CatalogStorePort } from '../workspace/ports';
import { createCatalogRegistry } from '../workspace/registry';
import type {
  EditorPort,
  LanePromptPort,
  LaneSelectionStorePort,
  LaneSessionStore,
  LaneTerminalPort,
  LaneViewRebindPort,
} from './ports';
import { ActiveLaneReconciliationError, createLaneService } from './service';

const workspaceKey = 'workspace:test' as WorkspaceKey;
const linkPath = '/repo/.lanes-root/active' as AbsolutePath;
const toFolder = (name: string): WorkspaceFolder => ({
  name,
  uri: `file:///repo/${name}` as UriString,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createPausedQueue = () => {
  let enqueueCount = 0;
  const queue: OperationQueue = {
    enqueue: <T>(): Promise<T> => {
      enqueueCount += 1;
      return new Promise<T>(() => {});
    },
  };
  return { queue, enqueueCount: () => enqueueCount };
};

const createHarness = ({
  initial = [toFolder('web'), toFolder('api')],
  saveCatalog = async () => {},
  closeLane = async () => {},
  revealLane = async () => {},
  pickLane = async () => undefined,
  promptRename = async () => 'frontend',
  confirmRemoval = async () => true,
  operationQueue: operationQueueOverride,
  rebindActiveFolder = async () => true,
  linkTarget = '/repo/web' as AbsolutePath,
  readLinkTarget,
  swapLink = () => {},
  clearLink = () => {},
  warnDirtyEditors = () => {},
  loadSelection,
  selectionLaneId = 'web' as LaneId,
  saveSelection = async () => {},
  rekeyTerminal = () => {},
  rekeyEditor = () => {},
}: {
  readonly initial?: readonly WorkspaceFolder[];
  readonly saveCatalog?: CatalogStorePort['save'];
  readonly closeLane?: LaneTerminalPort['closeLane'];
  readonly revealLane?: LaneTerminalPort['revealLane'];
  readonly pickLane?: LanePromptPort['pickLane'];
  readonly promptRename?: LanePromptPort['promptRename'];
  readonly confirmRemoval?: LanePromptPort['confirmRemoval'];
  readonly operationQueue?: OperationQueue;
  readonly rebindActiveFolder?: LaneViewRebindPort['rebindActiveFolder'];
  readonly linkTarget?: AbsolutePath | null;
  readonly readLinkTarget?: () => AbsolutePath | undefined;
  readonly swapLink?: (target: AbsolutePath) => void;
  readonly clearLink?: () => void;
  readonly warnDirtyEditors?: LanePromptPort['warnDirtyEditors'];
  readonly loadSelection?: LaneSelectionStorePort['load'];
  readonly selectionLaneId?: LaneId | undefined;
  readonly saveSelection?: LaneSelectionStorePort['save'];
  readonly rekeyTerminal?: (oldId: LaneId, newId: LaneId) => void;
  readonly rekeyEditor?: LaneSessionStore['rekey'];
} = {}) => {
  const store: CatalogStorePort = {
    load: () => initial,
    save: saveCatalog,
  };
  const registry = createCatalogRegistry(initial, store);
  let currentSelection = selectionLaneId;
  const selectionLoad = vi.fn<LaneSelectionStorePort['load']>(
    loadSelection ?? (() => currentSelection),
  );
  const selectionSave = vi.fn<LaneSelectionStorePort['save']>(async (key, laneId) => {
    await saveSelection(key, laneId);
    currentSelection = laneId;
  });
  const selectionStore: LaneSelectionStorePort = {
    load: selectionLoad,
    save: selectionSave,
  };
  const effectEvents: string[] = [];
  const terminalClose = vi.fn<LaneTerminalPort['closeLane']>(async (laneId) => {
    effectEvents.push('close');
    await closeLane(laneId);
  });
  const terminal: LaneTerminalPort = {
    revealLane,
    closeLane: terminalClose,
  };
  const terminalRekey = vi.fn<(oldId: LaneId, newId: LaneId) => void>(rekeyTerminal);
  const editorRekey = vi.fn<LaneSessionStore['rekey']>(rekeyEditor);
  const editorClear = vi.fn<LaneSessionStore['clear']>(() => {
    effectEvents.push('clear');
  });
  const editorStore: LaneSessionStore = {
    save: () => {},
    get: () => undefined,
    rekey: editorRekey,
    clear: editorClear,
  };
  const editorClose = vi.fn<EditorPort['closeAll']>(async () => {});
  const editor: EditorPort = {
    hasDirtyEditors: () => false,
    captureSnapshot: () => ({ tabs: [] }),
    closeAll: editorClose,
    restoreSnapshot: async () => {},
  };
  const viewRebind = vi.fn<LaneViewRebindPort['rebindActiveFolder']>(rebindActiveFolder);
  const prompt: LanePromptPort = {
    pickLane,
    warnDirtyEditors,
    promptRename,
    confirmRemoval,
    warnActiveLaneRemoval: () => {},
    pickFoldersToAdd: async () => [],
    warnAddFolderFailed: () => {},
  };
  let operationEnqueueCount = 0;
  const operationQueue: OperationQueue = operationQueueOverride ?? {
    enqueue: async <T>(operation: () => Promise<T>): Promise<T> => {
      operationEnqueueCount += 1;
      return operation();
    },
  };
  let currentLinkTarget: AbsolutePath | undefined = linkTarget ?? undefined;
  const linkRead = vi.fn(() => (readLinkTarget ? readLinkTarget() : currentLinkTarget));
  const linkSwap = vi.fn((target: AbsolutePath) => {
    swapLink(target);
    currentLinkTarget = target;
  });
  const linkClear = vi.fn(() => {
    clearLink();
    currentLinkTarget = undefined;
  });
  const service = createLaneService({
    getCatalog: () => registry.snapshot(),
    workspaceKey,
    editor,
    link: {
      linkPath,
      readTarget: linkRead,
      swap: linkSwap,
      clear: linkClear,
    },
    terminal,
    viewRebind: { rebindActiveFolder: viewRebind },
    selectionStore,
    prompt,
    registry,
    terminalRekey: { rekeyLane: terminalRekey },
    editorStore,
    operationQueue,
  });

  return {
    service,
    registry,
    selectionLoad,
    selectionSave,
    linkRead,
    linkSwap,
    linkClear,
    terminalClose,
    terminalRekey,
    editorRekey,
    editorClear,
    effectEvents,
    viewRebind,
    editorClose,
    operationEnqueueCount: () => operationEnqueueCount,
    currentLinkTarget: () => currentLinkTarget,
    setLinkTarget: (target: AbsolutePath | undefined) => {
      currentLinkTarget = target;
    },
    setSelection: (laneId: LaneId | undefined) => {
      currentSelection = laneId;
    },
  };
};

describe('createLaneService active lane reconciliation', () => {
  it('構築時は selection cache を読まず active lane を未確定にする', () => {
    const h = createHarness();

    expect(h.service.snapshot().activeLaneId).toBeUndefined();
    expect(h.selectionLoad).not.toHaveBeenCalled();
  });

  it('valid link target を stale selection cache より優先する', async () => {
    const h = createHarness({
      linkTarget: '/repo/api' as AbsolutePath,
      selectionLaneId: 'web' as LaneId,
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'saved',
    });

    expect(h.service.snapshot().activeLaneId).toBe('api');
    expect(h.linkSwap).not.toHaveBeenCalled();
    expect(h.viewRebind).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'api', rootPath: '/repo/api' }),
    );
    expect(h.selectionSave).toHaveBeenCalledWith(workspaceKey, 'api');
  });

  it('invalid link target なら valid selection cache を選ぶ', async () => {
    const h = createHarness({
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'saved',
    });

    expect(h.service.snapshot().activeLaneId).toBe('api');
    expect(h.linkSwap).toHaveBeenCalledOnce();
    expect(h.linkSwap).toHaveBeenCalledWith('/repo/api');
    expect(h.selectionSave).not.toHaveBeenCalled();
  });

  it('link target と selection cache が無効なら catalog 先頭を選ぶ', async () => {
    const h = createHarness({
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'unknown' as LaneId,
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'saved',
    });

    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.linkSwap).toHaveBeenCalledWith('/repo/web');
    expect(h.selectionSave).toHaveBeenCalledWith(workspaceKey, 'web');
  });

  it('queue 待機後の最新 catalog、link target、selection cache を読む', async () => {
    const gate = deferred();
    const operationQueue = createOperationQueue();
    const holding = operationQueue.enqueue(() => gate.promise);
    const h = createHarness({ operationQueue });

    const reconciling = h.service.reconcileActiveLane();
    await h.registry.replace([toFolder('api'), toFolder('worker')]);
    h.setLinkTarget('/repo/worker' as AbsolutePath);
    h.setSelection('api' as LaneId);

    expect(h.selectionLoad).not.toHaveBeenCalled();
    expect(h.linkRead).not.toHaveBeenCalled();

    gate.resolve();
    await holding;
    await reconciling;

    expect(h.service.snapshot().activeLaneId).toBe('worker');
    expect(h.linkSwap).not.toHaveBeenCalled();
    expect(h.selectionSave).toHaveBeenCalledWith(workspaceKey, 'worker');
  });

  it('link swap が不要でも active folder view を再構成する', async () => {
    const h = createHarness({
      linkTarget: '/repo/web' as AbsolutePath,
      selectionLaneId: 'web' as LaneId,
    });

    await h.service.reconcileActiveLane();

    expect(h.linkSwap).not.toHaveBeenCalled();
    expect(h.viewRebind).toHaveBeenCalledOnce();
    expect(h.viewRebind).toHaveBeenCalledWith(expect.objectContaining({ id: 'web' }));
  });

  it('view mutation が false なら link を旧 target へ戻して reject する', async () => {
    const h = createHarness({
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
      rebindActiveFolder: async () => false,
    });

    await expect(h.service.reconcileActiveLane()).rejects.toMatchObject({
      reason: 'workspace-folder-mutation-rejected',
    });

    expect(h.linkSwap.mock.calls).toEqual([['/repo/api'], ['/repo/unknown']]);
    expect(h.currentLinkTarget()).toBe('/repo/unknown');
    expect(h.service.snapshot().activeLaneId).toBeUndefined();
    expect(h.selectionSave).not.toHaveBeenCalled();
  });

  it('view mutation の reject を伝播し link を旧 target へ戻す', async () => {
    const failure = new Error('view failed');
    const h = createHarness({
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
      rebindActiveFolder: async () => {
        throw failure;
      },
    });

    await expect(h.service.reconcileActiveLane()).rejects.toMatchObject({
      reason: 'workspace-folder-mutation-rejected',
      cause: failure,
    });

    expect(h.linkSwap.mock.calls).toEqual([['/repo/api'], ['/repo/unknown']]);
    expect(h.currentLinkTarget()).toBe('/repo/unknown');
  });

  it('旧 link が未作成なら view failure 時に作成した link を clear する', async () => {
    const h = createHarness({
      linkTarget: null,
      selectionLaneId: 'api' as LaneId,
      rebindActiveFolder: async () => false,
    });

    await expect(h.service.reconcileActiveLane()).rejects.toMatchObject({
      reason: 'workspace-folder-mutation-rejected',
    });

    expect(h.linkSwap).toHaveBeenCalledWith('/repo/api');
    expect(h.linkClear).toHaveBeenCalledOnce();
    expect(h.currentLinkTarget()).toBeUndefined();
  });

  it('旧 target への rollback swap 失敗は元 error と AggregateError にする', async () => {
    const rollbackError = new Error('rollback swap failed');
    let swapCount = 0;
    const h = createHarness({
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
      rebindActiveFolder: async () => false,
      swapLink: () => {
        swapCount += 1;
        if (swapCount === 2) throw rollbackError;
      },
    });

    const failure = await h.service.reconcileActiveLane().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActiveLaneReconciliationError);
    expect(failure).toMatchObject({ reason: 'rollback-failed' });
    expect((failure as ActiveLaneReconciliationError).cause).toBeInstanceOf(AggregateError);
    expect(((failure as ActiveLaneReconciliationError).cause as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'workspace-folder-mutation-rejected' }),
      rollbackError,
    ]);
  });

  it('未作成 link の rollback clear 失敗は元 error と AggregateError にする', async () => {
    const rollbackError = new Error('rollback clear failed');
    const h = createHarness({
      linkTarget: null,
      selectionLaneId: 'api' as LaneId,
      rebindActiveFolder: async () => false,
      clearLink: () => {
        throw rollbackError;
      },
    });

    const failure = await h.service.reconcileActiveLane().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActiveLaneReconciliationError);
    expect(failure).toMatchObject({ reason: 'rollback-failed' });
    expect((failure as ActiveLaneReconciliationError).cause).toBeInstanceOf(AggregateError);
    expect(((failure as ActiveLaneReconciliationError).cause as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'workspace-folder-mutation-rejected' }),
      rollbackError,
    ]);
  });

  it('最初の link swap 失敗は view と rollback を実行せず伝播する', async () => {
    const failure = new Error('swap failed');
    const h = createHarness({
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
      swapLink: () => {
        throw failure;
      },
    });

    await expect(h.service.reconcileActiveLane()).rejects.toMatchObject({
      reason: 'link-swap-failed',
      cause: failure,
    });

    expect(h.linkSwap).toHaveBeenCalledOnce();
    expect(h.linkClear).not.toHaveBeenCalled();
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('selection save 中は target を active lane として公開する', async () => {
    let observedActive: LaneId | undefined;
    let service: ReturnType<typeof createHarness>['service'];
    const h = createHarness({
      linkTarget: '/repo/api' as AbsolutePath,
      selectionLaneId: 'web' as LaneId,
      saveSelection: async () => {
        observedActive = service.snapshot().activeLaneId;
      },
    });
    service = h.service;

    await h.service.reconcileActiveLane();

    expect(observedActive).toBe('api');
  });

  it('post-commit save failure は target を維持した pending result とし次回 cache のみ直す', async () => {
    const saveFailure = new Error('selection failed');
    let saveCount = 0;
    const h = createHarness({
      initial: [toFolder('api'), toFolder('web')],
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'unknown' as LaneId,
      saveSelection: async () => {
        saveCount += 1;
        if (saveCount === 1) throw saveFailure;
      },
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'pending',
      error: saveFailure,
    });
    expect(h.service.snapshot().activeLaneId).toBe('api');
    expect(h.currentLinkTarget()).toBe('/repo/api');

    h.linkSwap.mockClear();
    h.viewRebind.mockClear();
    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'saved',
    });

    expect(h.linkSwap).not.toHaveBeenCalled();
    expect(h.viewRebind).toHaveBeenCalledOnce();
    expect(h.selectionSave).toHaveBeenCalledTimes(2);
  });

  it('catalog が空なら active を未確定にする以外の副作用を起こさない', async () => {
    let saveCount = 0;
    const h = createHarness({
      saveSelection: async () => {
        saveCount += 1;
        if (saveCount === 1) throw new Error('pending focus save');
      },
    });
    const focusResult = await h.service.focus('api' as LaneId);
    expect(focusResult.kind).toBe('failed');
    await h.registry.replace([]);
    h.selectionLoad.mockClear();
    h.selectionSave.mockClear();
    h.linkRead.mockClear();
    h.linkSwap.mockClear();
    h.linkClear.mockClear();
    h.viewRebind.mockClear();

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({ kind: 'empty' });

    expect(h.service.snapshot().activeLaneId).toBeUndefined();
    expect(h.selectionLoad).not.toHaveBeenCalled();
    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.linkRead).not.toHaveBeenCalled();
    expect(h.linkSwap).not.toHaveBeenCalled();
    expect(h.linkClear).not.toHaveBeenCalled();
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('pending focus finalization を確定してから最新 cache で再整合する', async () => {
    const events: string[] = [];
    let saveCount = 0;
    let linkedTarget = '/repo/web' as AbsolutePath;
    const h = createHarness({
      loadSelection: () => {
        events.push('load');
        return saveCount >= 2 ? ('api' as LaneId) : ('web' as LaneId);
      },
      saveSelection: async () => {
        saveCount += 1;
        events.push(`save:${saveCount}`);
        if (saveCount === 1) throw new Error('pending focus save');
      },
      readLinkTarget: () => {
        events.push('link');
        return linkedTarget;
      },
      swapLink: (target) => {
        linkedTarget = target;
      },
      rebindActiveFolder: async () => {
        events.push('view');
        return true;
      },
    });
    const focusResult = await h.service.focus('api' as LaneId);
    expect(focusResult.kind).toBe('failed');
    events.splice(0);

    await h.service.reconcileActiveLane();

    expect(events).toEqual(['save:2', 'link', 'load', 'view']);
    expect(h.selectionSave).toHaveBeenCalledTimes(2);
  });

  it('pending rename finalization を確定してから最新 cache で再整合する', async () => {
    const events: string[] = [];
    let saveCount = 0;
    const h = createHarness({
      loadSelection: () => {
        events.push('load');
        return saveCount >= 2 ? ('frontend' as LaneId) : ('web' as LaneId);
      },
      saveSelection: async () => {
        saveCount += 1;
        events.push(`save:${saveCount}`);
        if (saveCount === 1) throw new Error('pending rename save');
      },
      readLinkTarget: () => {
        events.push('link');
        return '/repo/web' as AbsolutePath;
      },
      rebindActiveFolder: async (lane) => {
        events.push(`view:${lane.id}`);
        return true;
      },
    });
    await h.service.reconcileActiveLane();
    events.splice(0);
    await expect(h.service.renameLane('web' as LaneId)).rejects.toThrow('pending rename save');
    events.splice(0);

    await h.service.reconcileActiveLane();

    expect(events).toEqual(['save:2', 'view:frontend', 'link', 'load', 'view:frontend']);
    expect(h.selectionSave).toHaveBeenCalledTimes(2);
  });

  it('失敗した reconciliation の後続 operation を queue が実行する', async () => {
    let viewCount = 0;
    const h = createHarness({
      operationQueue: createOperationQueue(),
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
      rebindActiveFolder: async () => {
        viewCount += 1;
        return viewCount > 1;
      },
    });

    const first = h.service.reconcileActiveLane();
    const second = h.service.reconcileActiveLane();

    await expect(first).rejects.toThrow('workspace-folder-mutation-rejected');
    await expect(second).resolves.toEqual({ kind: 'active', cache: 'saved' });
    expect(h.service.snapshot().activeLaneId).toBe('api');
  });
});

describe('createLaneService operation queue', () => {
  it('focus を共通 queue へ投入する', async () => {
    const h = createHarness();

    await h.service.focus('api' as LaneId);

    expect(h.operationEnqueueCount()).toBe(1);
  });

  it('rename を共通 queue へ投入する', async () => {
    const h = createHarness();

    await h.service.renameLane('web' as LaneId);

    expect(h.operationEnqueueCount()).toBe(1);
  });

  it('remove を共通 queue へ投入する', async () => {
    const h = createHarness();

    await h.service.removeLane('api' as LaneId);

    expect(h.operationEnqueueCount()).toBe(1);
  });
});

describe('createLaneService interaction boundary', () => {
  it('focus QuickPick を queue 外で完了してから mutation を enqueue する', async () => {
    const paused = createPausedQueue();
    const pickLane = vi.fn<LanePromptPort['pickLane']>(async () => 'api' as LaneId);
    const h = createHarness({ operationQueue: paused.queue, pickLane });

    void h.service.focus();
    await Promise.resolve();
    await Promise.resolve();

    expect(pickLane).toHaveBeenCalledOnce();
    expect(paused.enqueueCount()).toBe(1);
  });

  it('rename input を queue 外で完了してから mutation を enqueue する', async () => {
    const paused = createPausedQueue();
    const promptRename = vi.fn<LanePromptPort['promptRename']>(async () => 'frontend');
    const h = createHarness({ operationQueue: paused.queue, promptRename });

    void h.service.renameLane('web' as LaneId);
    await Promise.resolve();
    await Promise.resolve();

    expect(promptRename).toHaveBeenCalledOnce();
    expect(paused.enqueueCount()).toBe(1);
  });

  it('remove confirmation を queue 外で完了してから mutation を enqueue する', async () => {
    const paused = createPausedQueue();
    const confirmRemoval = vi.fn<LanePromptPort['confirmRemoval']>(async () => true);
    const h = createHarness({ operationQueue: paused.queue, confirmRemoval });

    void h.service.removeLane('api' as LaneId);
    await Promise.resolve();
    await Promise.resolve();

    expect(confirmRemoval).toHaveBeenCalledOnce();
    expect(paused.enqueueCount()).toBe(1);
  });

  it('queue 待機中に focus target が消えた場合は tabs を閉じない', async () => {
    const gate = deferred();
    const operationQueue = createOperationQueue();
    const holding = operationQueue.enqueue(() => gate.promise);
    const h = createHarness({ operationQueue });

    const focusing = h.service.focus('api' as LaneId);
    await h.registry.remove('api');
    gate.resolve();
    await holding;

    await expect(focusing).resolves.toEqual({ kind: 'noop', reason: 'no-target' });
    expect(h.editorClose).not.toHaveBeenCalled();
  });

  it('reconciliation-required を dirty editor として警告しない', async () => {
    const warnDirtyEditors = vi.fn();
    const h = createHarness({
      linkTarget: '/repo/missing' as AbsolutePath,
      warnDirtyEditors,
    });

    await expect(h.service.focus('api' as LaneId)).resolves.toEqual({
      kind: 'blocked',
      reason: 'reconciliation-required',
    });
    expect(warnDirtyEditors).not.toHaveBeenCalled();
  });
});

describe('createLaneService FIFO', () => {
  it('concurrent focus を enqueue 順に実行する', async () => {
    const firstStarted = deferred();
    const firstGate = deferred();
    const events: string[] = [];
    const h = createHarness({
      operationQueue: createOperationQueue(),
      rebindActiveFolder: async (activeLane) => {
        events.push(`view:${activeLane.id}:start`);
        if (activeLane.id === ('api' as LaneId)) {
          firstStarted.resolve();
          await firstGate.promise;
        }
        events.push(`view:${activeLane.id}:end`);
        return true;
      },
    });

    const first = h.service.focus('api' as LaneId);
    await firstStarted.promise;
    const second = h.service.focus('web' as LaneId);
    await Promise.resolve();

    expect(events).toEqual(['view:api:start']);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['view:api:start', 'view:api:end', 'view:web:start', 'view:web:end']);
  });

  it('focus 完了後に queued rename を実行する', async () => {
    const focusStarted = deferred();
    const focusGate = deferred();
    const events: string[] = [];
    const h = createHarness({
      operationQueue: createOperationQueue(),
      rebindActiveFolder: async () => {
        events.push('focus:start');
        focusStarted.resolve();
        await focusGate.promise;
        events.push('focus:end');
        return true;
      },
      saveCatalog: async () => {
        events.push('rename:save');
      },
    });

    const focusing = h.service.focus('api' as LaneId);
    await focusStarted.promise;
    const renaming = h.service.renameLane('web' as LaneId);
    await Promise.resolve();

    expect(events).toEqual(['focus:start']);

    focusGate.resolve();
    await Promise.all([focusing, renaming]);
    expect(events).toEqual(['focus:start', 'focus:end', 'rename:save']);
  });

  it('focus 完了後の active state で queued remove を再判定する', async () => {
    const focusStarted = deferred();
    const focusGate = deferred();
    const events: string[] = [];
    const h = createHarness({
      operationQueue: createOperationQueue(),
      rebindActiveFolder: async () => {
        events.push('focus:start');
        focusStarted.resolve();
        await focusGate.promise;
        events.push('focus:end');
        return true;
      },
      saveCatalog: async () => {
        events.push('remove:save');
      },
    });

    const focusing = h.service.focus('api' as LaneId);
    await focusStarted.promise;
    const removing = h.service.removeLane('web' as LaneId);
    await Promise.resolve();

    expect(events).toEqual(['focus:start']);

    focusGate.resolve();
    await Promise.all([focusing, removing]);
    expect(events).toEqual(['focus:start', 'focus:end', 'remove:save']);
    expect(h.registry.snapshot().byId.has('web' as LaneId)).toBe(false);
  });

  it('pending focus finalization を次 mutation より前に再試行する', async () => {
    const events: string[] = [];
    let revealCount = 0;
    const h = createHarness({
      operationQueue: createOperationQueue(),
      revealLane: async () => {
        revealCount += 1;
        events.push(`terminal:${revealCount}`);
        if (revealCount === 1) throw new Error('terminal failed');
      },
      saveCatalog: async () => {
        events.push('rename:save');
      },
    });

    const focusResult = await h.service.focus('api' as LaneId);
    expect(focusResult.kind).toBe('failed');

    await h.service.renameLane('web' as LaneId);

    expect(events).toEqual(['terminal:1', 'terminal:2', 'rename:save']);
  });
});

describe('createLaneService catalog mutation ordering', () => {
  it('rename の catalog 保存失敗時は関連副作用を実行しない', async () => {
    const failure = new Error('save failed');
    const h = createHarness({
      saveCatalog: async () => {
        throw failure;
      },
    });
    await h.service.reconcileActiveLane();
    h.selectionSave.mockClear();
    h.viewRebind.mockClear();

    await expect(h.service.renameLane('web' as LaneId)).rejects.toBe(failure);

    expect(h.terminalRekey).not.toHaveBeenCalled();
    expect(h.editorRekey).not.toHaveBeenCalled();
    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('rename listener は rekey と active selection 更新後の状態を観測', async () => {
    const h = createHarness();
    await h.service.reconcileActiveLane();
    h.selectionSave.mockClear();
    h.viewRebind.mockClear();
    let observed:
      | {
          readonly terminalRekeyed: boolean;
          readonly editorRekeyed: boolean;
          readonly selectedLane: LaneId | undefined;
          readonly persistedLane: LaneId | undefined;
        }
      | undefined;
    h.registry.onChange(() => {
      observed = {
        terminalRekeyed: h.terminalRekey.mock.calls.length === 1,
        editorRekeyed: h.editorRekey.mock.calls.length === 1,
        selectedLane: h.service.snapshot().activeLaneId,
        persistedLane: h.selectionSave.mock.calls[0]?.[1],
      };
    });

    await h.service.renameLane('web' as LaneId);

    expect(observed).toEqual({
      terminalRekeyed: true,
      editorRekeyed: true,
      selectedLane: 'frontend',
      persistedLane: 'frontend',
    });
  });

  it('active rename の selection 保存失敗を次 operation 前に再試行する', async () => {
    const failure = new Error('selection failed');
    let saveCount = 0;
    const h = createHarness({
      saveSelection: async () => {
        saveCount += 1;
        if (saveCount === 1) throw failure;
      },
    });
    await h.service.reconcileActiveLane();
    h.selectionSave.mockClear();
    h.viewRebind.mockClear();

    await expect(h.service.renameLane('web' as LaneId)).rejects.toBe(failure);

    expect(h.registry.snapshot().byId.has('frontend' as LaneId)).toBe(true);
    expect(h.service.snapshot().activeLaneId).toBe('frontend');
    expect(h.viewRebind).not.toHaveBeenCalled();

    await h.service.finalizePendingOperations();

    expect(h.selectionSave).toHaveBeenCalledTimes(2);
    expect(h.viewRebind).toHaveBeenCalledOnce();
    expect(h.viewRebind.mock.calls[0]?.[0].id).toBe('frontend');
  });

  it('active rename の view mutation 拒否を selection 再保存なしで再試行する', async () => {
    let rebindCount = 0;
    const h = createHarness({
      rebindActiveFolder: async () => {
        rebindCount += 1;
        return rebindCount !== 2;
      },
    });
    await h.service.reconcileActiveLane();
    h.selectionSave.mockClear();
    h.viewRebind.mockClear();

    await expect(h.service.renameLane('web' as LaneId)).rejects.toThrow(
      'workspace-folder-mutation-rejected',
    );

    expect(h.registry.snapshot().byId.has('frontend' as LaneId)).toBe(true);
    expect(h.service.snapshot().activeLaneId).toBe('frontend');
    expect(h.selectionSave).toHaveBeenCalledOnce();

    await h.service.finalizePendingOperations();

    expect(h.selectionSave).toHaveBeenCalledOnce();
    expect(h.viewRebind).toHaveBeenCalledTimes(2);
  });

  it('non-active rename の terminal rekey 失敗を同じ段階から再試行する', async () => {
    const failure = new Error('terminal rekey failed');
    let rekeyCount = 0;
    const h = createHarness({
      rekeyTerminal: () => {
        rekeyCount += 1;
        if (rekeyCount === 1) throw failure;
      },
    });

    await expect(h.service.renameLane('api' as LaneId)).rejects.toBe(failure);
    expect(h.registry.snapshot().byId.has('frontend' as LaneId)).toBe(true);
    expect(h.terminalRekey).toHaveBeenCalledOnce();
    expect(h.editorRekey).not.toHaveBeenCalled();

    await h.service.finalizePendingOperations();

    expect(h.terminalRekey).toHaveBeenCalledTimes(2);
    expect(h.editorRekey).toHaveBeenCalledOnce();
    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('non-active rename の editor rekey 失敗時は terminal rekey を繰り返さない', async () => {
    const failure = new Error('editor rekey failed');
    let rekeyCount = 0;
    const h = createHarness({
      rekeyEditor: () => {
        rekeyCount += 1;
        if (rekeyCount === 1) throw failure;
      },
    });

    await expect(h.service.renameLane('api' as LaneId)).rejects.toBe(failure);
    expect(h.registry.snapshot().byId.has('frontend' as LaneId)).toBe(true);
    expect(h.terminalRekey).toHaveBeenCalledOnce();
    expect(h.editorRekey).toHaveBeenCalledOnce();

    await h.service.finalizePendingOperations();

    expect(h.terminalRekey).toHaveBeenCalledOnce();
    expect(h.editorRekey).toHaveBeenCalledTimes(2);
    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('remove の catalog 保存失敗時は close と clear を実行しない', async () => {
    const failure = new Error('save failed');
    const h = createHarness({
      saveCatalog: async () => {
        throw failure;
      },
    });

    await expect(h.service.removeLane('api' as LaneId)).rejects.toBe(failure);

    expect(h.terminalClose).not.toHaveBeenCalled();
    expect(h.editorClear).not.toHaveBeenCalled();
    expect(h.registry.snapshot().byId.has('api' as LaneId)).toBe(true);
  });

  it('remove の close 失敗時も catalog を公開して clear 後に失敗を返す', async () => {
    const failure = new Error('close failed');
    const h = createHarness({
      closeLane: async () => {
        throw failure;
      },
    });
    let notificationCount = 0;
    h.registry.onChange(() => {
      notificationCount += 1;
    });

    await expect(h.service.removeLane('api' as LaneId)).rejects.toBe(failure);

    expect(h.registry.snapshot().byId.has('api' as LaneId)).toBe(false);
    expect(notificationCount).toBe(1);
    expect(h.editorClear).toHaveBeenCalledOnce();
    expect(h.editorClear).toHaveBeenCalledWith('api');
    expect(h.effectEvents).toEqual(['close', 'clear']);
  });
});
