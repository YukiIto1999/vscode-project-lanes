import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';
import { createOperationQueue, type OperationQueue } from '../foundation/operation-queue';
import type { CatalogEntry } from '../workspace/model';
import type { CatalogStorePort } from '../workspace/ports';
import { createCatalogRegistry } from '../workspace/registry';
import type {
  EditorSnapshotStorePort,
  EditorPort,
  LanePromptPort,
  LaneSelectionStorePort,
  LaneTerminalPort,
  LaneViewRebindPort,
} from './ports';
import type { LaneRootAvailability } from './model';
import { ActiveLaneReconciliationError, createLaneService } from './service';

const workspaceKey = 'workspace:test' as WorkspaceKey;
const linkPath = '/repo/.lanes-root/active' as AbsolutePath;
const toFolder = (name: string): CatalogEntry => ({
  id: name as LaneId,
  name,
  uri: `file:///repo/${name}` as UriString,
});
const laneIdFactory = () => {
  let nextId = 0;
  return { next: () => `generated-${(nextId += 1)}` as LaneId };
};

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
  pickReplacementFolder = async () => undefined,
  promptRename = async () => 'frontend',
  confirmRemoval = async () => true,
  operationQueue: operationQueueOverride,
  rebindActiveFolder = async () => true,
  linkTarget = '/repo/web' as AbsolutePath,
  readLinkTarget,
  readLegacyLinkTarget = () => undefined,
  swapLink = () => {},
  clearLink = () => {},
  warnDirtyEditors = () => {},
  loadSelection,
  selectionLaneId = 'web' as LaneId,
  saveSelection = async () => {},
  inspectRoot = () => 'available',
  hasDirtyEditors = () => false,
  captureSnapshot = () => ({ tabs: [] }),
  restoreSnapshot = async () => {},
  removeSnapshot = async () => {},
}: {
  readonly initial?: readonly CatalogEntry[];
  readonly saveCatalog?: CatalogStorePort['save'];
  readonly closeLane?: LaneTerminalPort['closeLane'];
  readonly revealLane?: LaneTerminalPort['revealLane'];
  readonly pickLane?: LanePromptPort['pickLane'];
  readonly pickReplacementFolder?: LanePromptPort['pickReplacementFolder'];
  readonly promptRename?: LanePromptPort['promptRename'];
  readonly confirmRemoval?: LanePromptPort['confirmRemoval'];
  readonly operationQueue?: OperationQueue;
  readonly rebindActiveFolder?: LaneViewRebindPort['rebindActiveFolder'];
  readonly linkTarget?: AbsolutePath | null;
  readonly readLinkTarget?: () => AbsolutePath | undefined;
  readonly readLegacyLinkTarget?: () => AbsolutePath | undefined;
  readonly swapLink?: (target: AbsolutePath) => void;
  readonly clearLink?: () => void;
  readonly warnDirtyEditors?: LanePromptPort['warnDirtyEditors'];
  readonly loadSelection?: LaneSelectionStorePort['load'];
  readonly selectionLaneId?: LaneId | undefined;
  readonly saveSelection?: LaneSelectionStorePort['save'];
  readonly inspectRoot?: (path: AbsolutePath) => LaneRootAvailability;
  readonly hasDirtyEditors?: EditorPort['hasDirtyEditors'];
  readonly captureSnapshot?: EditorPort['captureSnapshot'];
  readonly restoreSnapshot?: EditorPort['restoreSnapshot'];
  readonly removeSnapshot?: EditorSnapshotStorePort['remove'];
} = {}) => {
  let persistedFolders = initial;
  const store: CatalogStorePort = {
    load: () => persistedFolders,
    save: async (folders) => {
      await saveCatalog(folders);
      persistedFolders = folders;
    },
  };
  const registry = createCatalogRegistry(initial, store, laneIdFactory());
  let currentSelection =
    selectionLaneId === undefined ? undefined : ({ kind: 'v2', laneId: selectionLaneId } as const);
  const selectionLoad = vi.fn<LaneSelectionStorePort['load']>(
    loadSelection ?? (() => currentSelection),
  );
  const selectionSave = vi.fn<LaneSelectionStorePort['save']>(async (key, laneId) => {
    await saveSelection(key, laneId);
    currentSelection = laneId === undefined ? undefined : { kind: 'v2', laneId };
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
  const terminalReveal = vi.fn<LaneTerminalPort['revealLane']>(revealLane);
  const terminal: LaneTerminalPort = {
    revealLane: terminalReveal,
    closeLane: terminalClose,
  };
  const editorRemove = vi.fn<EditorSnapshotStorePort['remove']>(async (laneId) => {
    effectEvents.push('remove');
    await removeSnapshot(laneId);
  });
  const editorStore: EditorSnapshotStorePort = {
    save: async () => {},
    get: () => undefined,
    remove: editorRemove,
    prune: async () => 'unchanged',
  };
  const editorClose = vi.fn<EditorPort['closeAll']>(async () => true);
  const editorHasDirty = vi.fn<EditorPort['hasDirtyEditors']>(hasDirtyEditors);
  const editorCapture = vi.fn<EditorPort['captureSnapshot']>(captureSnapshot);
  const editorRestore = vi.fn<EditorPort['restoreSnapshot']>(restoreSnapshot);
  const editor: EditorPort = {
    hasDirtyEditors: editorHasDirty,
    captureSnapshot: editorCapture,
    closeAll: editorClose,
    restoreSnapshot: editorRestore,
  };
  const viewRebind = vi.fn<LaneViewRebindPort['rebindActiveFolder']>(rebindActiveFolder);
  const prompt: LanePromptPort = {
    pickLane,
    pickReplacementFolder,
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
  const legacyLinkRead = vi.fn(readLegacyLinkTarget);
  const linkSwap = vi.fn((target: AbsolutePath) => {
    swapLink(target);
    currentLinkTarget = target;
  });
  const linkClear = vi.fn(() => {
    clearLink();
    currentLinkTarget = undefined;
  });
  const rootAvailability = {
    inspect: vi.fn((path: AbsolutePath) => inspectRoot(path)),
  };
  const createService = (serviceRegistry = registry) =>
    createLaneService({
      getCatalog: () => serviceRegistry.snapshot(),
      workspaceKey,
      editor,
      link: {
        linkPath,
        readTarget: linkRead,
        swap: linkSwap,
        clear: linkClear,
      },
      readLegacyLinkTarget: legacyLinkRead,
      terminal,
      viewRebind: { rebindActiveFolder: viewRebind },
      selectionStore,
      prompt,
      registry: serviceRegistry,
      editorStore,
      operationQueue,
      rootAvailability,
    });
  const service = createService();

  return {
    service,
    recreateService: () =>
      createService(createCatalogRegistry(store.load() ?? [], store, laneIdFactory())),
    registry,
    selectionLoad,
    selectionSave,
    linkRead,
    legacyLinkRead,
    linkSwap,
    linkClear,
    rootAvailability,
    terminalReveal,
    terminalClose,
    editorRemove,
    effectEvents,
    viewRebind,
    editorHasDirty,
    editorCapture,
    editorClose,
    editorRestore,
    operationEnqueueCount: () => operationEnqueueCount,
    currentLinkTarget: () => currentLinkTarget,
    setLinkTarget: (target: AbsolutePath | undefined) => {
      currentLinkTarget = target;
    },
    setSelection: (laneId: LaneId | undefined) => {
      currentSelection = laneId === undefined ? undefined : { kind: 'v2', laneId };
    },
    setLegacySelection: (label: string | undefined) => {
      currentSelection = label === undefined ? undefined : { kind: 'legacy', label };
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

  it('new link 未作成で cache が無効なら catalog 内の旧 link target を新 link へ移行する', async () => {
    const h = createHarness({
      linkTarget: null,
      selectionLaneId: 'unknown' as LaneId,
      readLegacyLinkTarget: () => '/repo/api' as AbsolutePath,
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'saved',
    });

    expect(h.legacyLinkRead).toHaveBeenCalledOnce();
    expect(h.linkSwap).toHaveBeenCalledWith('/repo/api');
    expect(h.currentLinkTarget()).toBe('/repo/api');
    expect(h.service.snapshot().activeLaneId).toBe('api');
  });

  it('new link 未作成でも valid selection cache を旧 link target より優先する', async () => {
    const h = createHarness({
      linkTarget: null,
      selectionLaneId: 'web' as LaneId,
      readLegacyLinkTarget: () => '/repo/api' as AbsolutePath,
    });

    await h.service.reconcileActiveLane();

    expect(h.linkSwap).toHaveBeenCalledWith('/repo/web');
    expect(h.service.snapshot().activeLaneId).toBe('web');
  });

  it('new link が存在すれば旧 link を読まない', async () => {
    const h = createHarness({
      linkTarget: '/repo/unknown' as AbsolutePath,
      selectionLaneId: 'web' as LaneId,
      readLegacyLinkTarget: () => '/repo/api' as AbsolutePath,
    });

    await h.service.reconcileActiveLane();

    expect(h.legacyLinkRead).not.toHaveBeenCalled();
    expect(h.linkSwap).toHaveBeenCalledWith('/repo/web');
  });

  it('旧 link からの移行後に view mutation が失敗しても旧 link は変更せず new link だけ消す', async () => {
    const legacyTarget = '/repo/api' as AbsolutePath;
    const h = createHarness({
      linkTarget: null,
      selectionLaneId: 'unknown' as LaneId,
      readLegacyLinkTarget: () => legacyTarget,
      rebindActiveFolder: async () => false,
    });

    await expect(h.service.reconcileActiveLane()).rejects.toMatchObject({
      reason: 'workspace-folder-mutation-rejected',
    });

    expect(h.linkSwap).toHaveBeenCalledWith('/repo/api');
    expect(h.linkClear).toHaveBeenCalledOnce();
    expect(h.currentLinkTarget()).toBeUndefined();
    expect(h.legacyLinkRead()).toBe(legacyTarget);
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

  it('active root が missing なら catalog 先頭の available lane へ退避する', async () => {
    const h = createHarness({
      linkTarget: '/repo/api' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'saved',
    });

    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.linkSwap).toHaveBeenCalledWith('/repo/web');
    expect(h.selectionSave).toHaveBeenCalledWith(workspaceKey, 'web');
    expect(h.editorClose).toHaveBeenCalledOnce();
    expect(h.rootAvailability.inspect.mock.calls.map(([path]) => path)).toEqual([
      '/repo/web',
      '/repo/api',
      '/repo/web',
      '/repo/web',
    ]);
  });

  it('active root が missing でも dirty editor があれば linked lane と cache を維持する', async () => {
    const warnDirtyEditors = vi.fn();
    const h = createHarness({
      linkTarget: '/repo/api' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
      hasDirtyEditors: () => true,
      warnDirtyEditors,
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'saved',
    });

    expect(h.service.snapshot().activeLaneId).toBe('api');
    expect(h.currentLinkTarget()).toBe('/repo/api');
    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.editorClose).not.toHaveBeenCalled();
    expect(h.viewRebind).not.toHaveBeenCalled();
    expect(h.terminalClose).not.toHaveBeenCalled();
    expect(h.terminalReveal).not.toHaveBeenCalled();
    expect(warnDirtyEditors).toHaveBeenCalledOnce();
  });

  it('missing active lane からの退避失敗は link、view、tabs を linked lane へ戻す', async () => {
    const sourceSnapshot = {
      tabs: [{ uri: 'file:///repo/api/source.ts' as UriString, viewColumn: 1 }],
    };
    const h = createHarness({
      linkTarget: '/repo/api' as AbsolutePath,
      selectionLaneId: 'api' as LaneId,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
      captureSnapshot: () => sourceSnapshot,
      rebindActiveFolder: async (lane) => lane.id === ('api' as LaneId),
    });

    await expect(h.service.reconcileActiveLane()).rejects.toBeInstanceOf(
      ActiveLaneReconciliationError,
    );

    expect(h.service.snapshot().activeLaneId).toBe('api');
    expect(h.currentLinkTarget()).toBe('/repo/api');
    expect(h.editorRestore).toHaveBeenCalledWith(sourceSnapshot);
    expect(h.viewRebind).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'api' }));
    expect(h.selectionSave).not.toHaveBeenCalled();
  });

  it('利用可能な lane が無ければ link、active、selection cache を消す', async () => {
    const h = createHarness({
      inspectRoot: () => 'inaccessible',
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'inactive',
      cache: 'saved',
    });

    expect(h.linkClear).toHaveBeenCalledOnce();
    expect(h.service.snapshot().activeLaneId).toBeUndefined();
    expect(h.selectionSave).toHaveBeenCalledWith(workspaceKey, undefined);
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('inactive の cache 保存失敗は link と active を消した pending result にする', async () => {
    const failure = new Error('selection clear failed');
    let saveCount = 0;
    const h = createHarness({
      inspectRoot: () => 'missing',
      saveSelection: async () => {
        saveCount += 1;
        if (saveCount === 1) throw failure;
      },
    });

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'inactive',
      cache: 'pending',
      error: failure,
    });
    expect(h.currentLinkTarget()).toBeUndefined();
    expect(h.service.snapshot().activeLaneId).toBeUndefined();

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'inactive',
      cache: 'saved',
    });
    expect(h.selectionSave).toHaveBeenCalledTimes(2);
  });

  it('inactive の link clear 失敗は active と cache を維持して伝播する', async () => {
    let availability: LaneRootAvailability = 'available';
    const clearFailure = new Error('clear failed');
    const h = createHarness({
      inspectRoot: () => availability,
      clearLink: () => {
        throw clearFailure;
      },
    });
    await h.service.reconcileActiveLane();
    h.selectionSave.mockClear();
    availability = 'missing';

    await expect(h.service.reconcileActiveLane()).rejects.toMatchObject({
      reason: 'link-clear-failed',
      cause: clearFailure,
    });

    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.selectionSave).not.toHaveBeenCalled();
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

  it('catalog が空でも pending を確定して link、active、selection cache を消す', async () => {
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

    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'empty',
      cache: 'saved',
    });

    expect(h.service.snapshot().activeLaneId).toBeUndefined();
    expect(h.selectionLoad).toHaveBeenCalledOnce();
    expect(h.selectionSave).toHaveBeenCalledWith(workspaceKey, undefined);
    expect(h.linkRead).toHaveBeenCalledOnce();
    expect(h.linkSwap).not.toHaveBeenCalled();
    expect(h.linkClear).toHaveBeenCalledOnce();
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('pending focus finalization を確定してから最新 cache で再整合する', async () => {
    const events: string[] = [];
    let saveCount = 0;
    let linkedTarget = '/repo/web' as AbsolutePath;
    const h = createHarness({
      loadSelection: () => {
        events.push('load');
        return {
          kind: 'v2',
          laneId: (saveCount >= 2 ? 'api' : 'web') as LaneId,
        };
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
  it('active rename は LaneId と terminal/editor/selection のキーを変更しない', async () => {
    const h = createHarness({ promptRename: async () => 'api' });
    await h.service.reconcileActiveLane();
    h.selectionSave.mockClear();
    h.viewRebind.mockClear();

    await h.service.renameLane('web' as LaneId);

    expect(h.registry.snapshot().lanes).toEqual([
      expect.objectContaining({ id: 'web', label: 'api', rootPath: '/repo/web' }),
      expect.objectContaining({ id: 'api', label: 'api', rootPath: '/repo/api' }),
    ]);
    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.viewRebind).toHaveBeenCalledWith(expect.objectContaining({ id: 'web', label: 'api' }));
  });

  it('rename 後に service を再生成しても同じ LaneId と新 label を復元する', async () => {
    const h = createHarness();
    await h.service.reconcileActiveLane();
    await h.service.renameLane('web' as LaneId);

    const restarted = h.recreateService();
    await restarted.reconcileActiveLane();

    expect(restarted.snapshot().activeLaneId).toBe('web');
    expect(restarted.snapshot().catalog.byId.get('web' as LaneId)).toMatchObject({
      id: 'web',
      label: 'frontend',
      rootPath: '/repo/web',
    });
  });

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

  it('relocate folder picker を queue 外で完了してから mutation を enqueue する', async () => {
    const paused = createPausedQueue();
    const pickReplacementFolder = vi.fn<LanePromptPort['pickReplacementFolder']>(
      async () => 'file:///moved/api' as UriString,
    );
    const h = createHarness({
      operationQueue: paused.queue,
      pickReplacementFolder,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
    });

    void h.service.relocateLane('api' as LaneId);
    await Promise.resolve();
    await Promise.resolve();

    expect(pickReplacementFolder).toHaveBeenCalledWith('/repo');
    expect(paused.enqueueCount()).toBe(1);
  });

  it('relocate folder picker を取り消したら mutation を enqueue しない', async () => {
    const h = createHarness({
      pickReplacementFolder: async () => undefined,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
    });

    await expect(h.service.relocateLane('api' as LaneId)).resolves.toBeUndefined();

    expect(h.operationEnqueueCount()).toBe(0);
  });

  it('relocate の明示 target が存在しなければ no-target を返して picker を開かない', async () => {
    const pickReplacementFolder = vi.fn<LanePromptPort['pickReplacementFolder']>();
    const h = createHarness({ pickReplacementFolder });

    await expect(h.service.relocateLane('missing' as LaneId)).resolves.toEqual({
      kind: 'noop',
      reason: 'no-target',
    });

    expect(pickReplacementFolder).not.toHaveBeenCalled();
    expect(h.operationEnqueueCount()).toBe(0);
  });

  it('relocate の明示 target が available なら picker を開かない', async () => {
    const pickReplacementFolder = vi.fn<LanePromptPort['pickReplacementFolder']>();
    const h = createHarness({ pickReplacementFolder });

    await expect(h.service.relocateLane('api' as LaneId)).resolves.toEqual({
      kind: 'noop',
      reason: 'no-target',
    });

    expect(pickReplacementFolder).not.toHaveBeenCalled();
    expect(h.operationEnqueueCount()).toBe(0);
  });

  it('relocate の対話選択には unavailable lane だけを渡す', async () => {
    const pickLane = vi.fn<LanePromptPort['pickLane']>(async () => 'api' as LaneId);
    const h = createHarness({
      pickLane,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
    });

    await expect(h.service.relocateLane()).resolves.toBeUndefined();

    expect(pickLane).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'api', rootPath: '/repo/api' }),
    ]);
  });

  it('relocate の対話選択は unavailable lane が無ければ picker を開かない', async () => {
    const pickLane = vi.fn<LanePromptPort['pickLane']>();
    const pickReplacementFolder = vi.fn<LanePromptPort['pickReplacementFolder']>();
    const h = createHarness({ pickLane, pickReplacementFolder });

    await expect(h.service.relocateLane()).resolves.toEqual({
      kind: 'noop',
      reason: 'no-target',
    });

    expect(pickLane).not.toHaveBeenCalled();
    expect(pickReplacementFolder).not.toHaveBeenCalled();
  });

  it('queue 待機中に focus target が消えた場合は tabs を閉じない', async () => {
    const gate = deferred();
    const operationQueue = createOperationQueue();
    const holding = operationQueue.enqueue(() => gate.promise);
    const h = createHarness({ operationQueue });

    const focusing = h.service.focus('api' as LaneId);
    await h.registry.remove('api' as LaneId);
    gate.resolve();
    await holding;

    await expect(focusing).resolves.toEqual({ kind: 'noop', reason: 'no-target' });
    expect(h.editorClose).not.toHaveBeenCalled();
  });

  it('queue 待機中に focus target root が missing になった場合は tabs を閉じない', async () => {
    const gate = deferred();
    const operationQueue = createOperationQueue();
    const holding = operationQueue.enqueue(() => gate.promise);
    let availability: LaneRootAvailability = 'available';
    const h = createHarness({
      operationQueue,
      inspectRoot: () => availability,
    });

    const focusing = h.service.focus('api' as LaneId);
    availability = 'missing';
    gate.resolve();
    await holding;

    await expect(focusing).resolves.toEqual({
      kind: 'blocked',
      reason: 'root-unavailable',
    });
    expect(h.editorClose).not.toHaveBeenCalled();
  });

  it('queue 待機中に relocation 先が missing になった場合は catalog を変更しない', async () => {
    const gate = deferred();
    const operationQueue = createOperationQueue();
    const holding = operationQueue.enqueue(() => gate.promise);
    let replacementAvailability: LaneRootAvailability = 'available';
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const h = createHarness({
      operationQueue,
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/api' as UriString,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : replacementAvailability),
    });

    const relocating = h.service.relocateLane('api' as LaneId);
    await Promise.resolve();
    replacementAvailability = 'missing';
    gate.resolve();
    await holding;

    await expect(relocating).resolves.toEqual({
      kind: 'rejected',
      reason: 'replacement-unavailable',
    });
    expect(saveCatalog).not.toHaveBeenCalled();
    expect(h.registry.snapshot().byId.get('api' as LaneId)?.rootPath).toBe('/repo/api');
  });

  it('queue 待機中に relocation target が available へ戻った場合は catalog を変更しない', async () => {
    const gate = deferred();
    const operationQueue = createOperationQueue();
    const holding = operationQueue.enqueue(() => gate.promise);
    let targetAvailability: LaneRootAvailability = 'missing';
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const h = createHarness({
      operationQueue,
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/api' as UriString,
      inspectRoot: (path) => (path === '/repo/api' ? targetAvailability : 'available'),
    });

    const relocating = h.service.relocateLane('api' as LaneId);
    await Promise.resolve();
    targetAvailability = 'available';
    gate.resolve();
    await holding;

    await expect(relocating).resolves.toEqual({
      kind: 'noop',
      reason: 'no-target',
    });
    expect(saveCatalog).not.toHaveBeenCalled();
    expect(h.registry.snapshot().byId.get('api' as LaneId)?.rootPath).toBe('/repo/api');
  });

  it('queue 待機中に relocation target が消えた場合は保存を再実行しない', async () => {
    const gate = deferred();
    const operationQueue = createOperationQueue();
    const holding = operationQueue.enqueue(() => gate.promise);
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const h = createHarness({
      operationQueue,
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/api' as UriString,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
    });

    const relocating = h.service.relocateLane('api' as LaneId);
    await h.registry.remove('api' as LaneId);
    saveCatalog.mockClear();
    gate.resolve();
    await holding;

    await expect(relocating).resolves.toEqual({ kind: 'noop', reason: 'no-target' });
    expect(saveCatalog).not.toHaveBeenCalled();
  });

  it('queue 待機中に追加された lane と relocation 先が重複すれば拒否する', async () => {
    const gate = deferred();
    const operationQueue = createOperationQueue();
    const holding = operationQueue.enqueue(() => gate.promise);
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const h = createHarness({
      operationQueue,
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/api' as UriString,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
    });

    const relocating = h.service.relocateLane('api' as LaneId);
    await h.registry.replace([
      toFolder('web'),
      toFolder('api'),
      { name: 'worker', uri: 'file:///moved/api' as UriString },
    ]);
    saveCatalog.mockClear();
    gate.resolve();
    await holding;

    await expect(relocating).resolves.toEqual({
      kind: 'rejected',
      reason: 'duplicate-root',
    });
    expect(saveCatalog).not.toHaveBeenCalled();
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

describe('createLaneService relocation', () => {
  it('active lane の URI だけを保存し同じ queue 内で link と view を再整合する', async () => {
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const h = createHarness({
      operationQueue: createOperationQueue(),
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/web' as UriString,
      inspectRoot: (path) => (path === '/repo/web' ? 'missing' : 'available'),
    });

    await expect(h.service.relocateLane('web' as LaneId)).resolves.toMatchObject({
      kind: 'relocate',
      target: { id: 'web', label: 'web', rootPath: '/repo/web' },
      replacementUri: 'file:///moved/web',
      replacementPath: '/moved/web',
    });

    expect(saveCatalog).toHaveBeenCalledWith([
      { id: 'web', name: 'web', uri: 'file:///moved/web' },
      { id: 'api', name: 'api', uri: 'file:///repo/api' },
    ]);
    expect(h.registry.snapshot().byId.get('web' as LaneId)).toMatchObject({
      id: 'web',
      label: 'web',
      rootPath: '/moved/web',
    });
    expect(h.linkSwap).toHaveBeenCalledWith('/moved/web');
    expect(h.viewRebind).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'web', rootPath: '/moved/web' }),
    );
    expect(h.service.snapshot().activeLaneId).toBe('web');
  });

  it('active link 再整合失敗は catalog を保存せず link と tabs を戻す', async () => {
    const failure = new Error('swap failed');
    const sourceSnapshot = {
      tabs: [{ uri: 'file:///repo/web/source.ts' as UriString, viewColumn: 1 }],
    };
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const h = createHarness({
      operationQueue: createOperationQueue(),
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/web' as UriString,
      inspectRoot: (path) => (path === '/repo/web' ? 'missing' : 'available'),
      captureSnapshot: () => sourceSnapshot,
      swapLink: (target) => {
        if (target === ('/moved/web' as AbsolutePath)) throw failure;
      },
    });

    await expect(h.service.relocateLane('web' as LaneId)).rejects.toBe(failure);

    expect(saveCatalog).not.toHaveBeenCalled();
    expect(h.registry.snapshot().byId.get('web' as LaneId)?.rootPath).toBe('/repo/web');
    expect(h.currentLinkTarget()).toBe('/repo/web');
    expect(h.editorRestore).toHaveBeenCalledWith(sourceSnapshot);
    expect(h.service.snapshot().activeLaneId).toBe('web');
  });

  it('active view 再整合失敗も catalog を保存せず旧 workspace へ戻す', async () => {
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const h = createHarness({
      operationQueue: createOperationQueue(),
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/web' as UriString,
      inspectRoot: (path) => (path === '/repo/web' ? 'missing' : 'available'),
      rebindActiveFolder: async (lane) => lane.rootPath === '/repo/web',
    });

    await expect(h.service.relocateLane('web' as LaneId)).rejects.toThrow(
      'workspace-folder-mutation-rejected',
    );

    expect(saveCatalog).not.toHaveBeenCalled();
    expect(h.registry.snapshot().byId.get('web' as LaneId)?.rootPath).toBe('/repo/web');
    expect(h.currentLinkTarget()).toBe('/repo/web');
    expect(h.viewRebind).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'web', rootPath: '/repo/web' }),
    );
  });

  it('active relocation は dirty editor があれば catalog 保存前に中止する', async () => {
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const warnDirtyEditors = vi.fn();
    const h = createHarness({
      operationQueue: createOperationQueue(),
      saveCatalog,
      warnDirtyEditors,
      hasDirtyEditors: () => true,
      pickReplacementFolder: async () => 'file:///moved/web' as UriString,
      inspectRoot: (path) => (path === '/repo/web' ? 'missing' : 'available'),
    });

    await expect(h.service.relocateLane('web' as LaneId)).resolves.toEqual({
      kind: 'blocked',
      reason: 'dirty-editors',
    });

    expect(saveCatalog).not.toHaveBeenCalled();
    expect(h.editorClose).not.toHaveBeenCalled();
    expect(h.currentLinkTarget()).toBe('/repo/web');
    expect(warnDirtyEditors).toHaveBeenCalledOnce();
  });

  it('active relocation の catalog 保存失敗は link、view、tabs を旧状態へ戻す', async () => {
    const failure = new Error('catalog save failed');
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {
      throw failure;
    });
    const h = createHarness({
      operationQueue: createOperationQueue(),
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/web' as UriString,
      inspectRoot: (path) => (path === '/repo/web' ? 'missing' : 'available'),
    });

    await expect(h.service.relocateLane('web' as LaneId)).rejects.toBe(failure);

    expect(saveCatalog).toHaveBeenCalledOnce();
    expect(h.registry.snapshot().byId.get('web' as LaneId)?.rootPath).toBe('/repo/web');
    expect(h.currentLinkTarget()).toBe('/repo/web');
    expect(h.editorRestore).toHaveBeenCalledOnce();
    expect(h.viewRebind).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'web', rootPath: '/repo/web' }),
    );
  });

  it('active relocation の catalog publish 後 listener failure は target を確定する', async () => {
    const failure = new Error('catalog listener failed');
    const saveCatalog = vi.fn<CatalogStorePort['save']>(async () => {});
    const h = createHarness({
      operationQueue: createOperationQueue(),
      saveCatalog,
      pickReplacementFolder: async () => 'file:///moved/web' as UriString,
      inspectRoot: (path) => (path === '/repo/web' ? 'missing' : 'available'),
    });
    h.registry.onChange(() => {
      throw failure;
    });

    await expect(h.service.relocateLane('web' as LaneId)).resolves.toMatchObject({
      kind: 'relocate',
      target: { id: 'web' },
      replacementPath: '/moved/web',
    });

    expect(saveCatalog).toHaveBeenCalledOnce();
    expect(h.registry.snapshot().byId.get('web' as LaneId)?.rootPath).toBe('/moved/web');
    expect(h.currentLinkTarget()).toBe('/moved/web');
    expect(h.editorRestore).not.toHaveBeenCalled();

    const restarted = h.recreateService();
    expect(restarted.snapshot().catalog.byId.get('web' as LaneId)?.rootPath).toBe('/moved/web');
    await expect(restarted.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'saved',
    });
    expect(restarted.snapshot().activeLaneId).toBe('web');
    expect(h.currentLinkTarget()).toBe('/moved/web');
  });

  it('non-active lane の relocation 後も active lane と link を維持する', async () => {
    const h = createHarness({
      operationQueue: createOperationQueue(),
      pickReplacementFolder: async () => 'file:///moved/api' as UriString,
      inspectRoot: (path) => (path === '/repo/api' ? 'missing' : 'available'),
    });

    await expect(h.service.relocateLane('api' as LaneId)).resolves.toMatchObject({
      kind: 'relocate',
      target: { id: 'api' },
      replacementPath: '/moved/api',
    });

    expect(h.registry.snapshot().byId.get('api' as LaneId)?.rootPath).toBe('/moved/api');
    expect(h.linkSwap).not.toHaveBeenCalled();
    expect(h.currentLinkTarget()).toBe('/repo/web');
    expect(h.service.snapshot().activeLaneId).toBe('web');
  });

  it('active relocation は stale selection cache より対象 lane を維持して cache も直す', async () => {
    const firstSaveFailure = new Error('selection failed');
    let saveCount = 0;
    let webAvailability: LaneRootAvailability = 'available';
    const h = createHarness({
      operationQueue: createOperationQueue(),
      selectionLaneId: 'api' as LaneId,
      saveSelection: async () => {
        saveCount += 1;
        if (saveCount === 1) throw firstSaveFailure;
      },
      pickReplacementFolder: async () => 'file:///moved/web' as UriString,
      inspectRoot: (path) => (path === '/repo/web' ? webAvailability : 'available'),
    });
    await expect(h.service.reconcileActiveLane()).resolves.toEqual({
      kind: 'active',
      cache: 'pending',
      error: firstSaveFailure,
    });
    expect(h.service.snapshot().activeLaneId).toBe('web');
    webAvailability = 'missing';

    await expect(h.service.relocateLane('web' as LaneId)).resolves.toMatchObject({
      kind: 'relocate',
      target: { id: 'web' },
    });

    expect(h.currentLinkTarget()).toBe('/moved/web');
    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.selectionSave).toHaveBeenLastCalledWith(workspaceKey, 'web');
    expect(h.selectionSave).toHaveBeenCalledTimes(2);
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

    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('active rename の view mutation 拒否を ID/selection 変更なしで再試行する', async () => {
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

    expect(h.registry.snapshot().byId.get('web' as LaneId)?.label).toBe('frontend');
    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.selectionSave).not.toHaveBeenCalled();

    await h.service.finalizePendingOperations();

    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.viewRebind).toHaveBeenCalledTimes(2);
  });

  it('non-active rename は表示名だけを保存し active view に触れない', async () => {
    const h = createHarness();

    await h.service.renameLane('api' as LaneId);

    expect(h.registry.snapshot().byId.get('api' as LaneId)?.label).toBe('frontend');
    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('remove の catalog 保存失敗時は terminal と snapshot を変更しない', async () => {
    const failure = new Error('save failed');
    const h = createHarness({
      saveCatalog: async () => {
        throw failure;
      },
    });

    await expect(h.service.removeLane('api' as LaneId)).rejects.toBe(failure);

    expect(h.terminalClose).not.toHaveBeenCalled();
    expect(h.editorRemove).not.toHaveBeenCalled();
    expect(h.registry.snapshot().byId.has('api' as LaneId)).toBe(true);
  });

  it('remove の terminal close 失敗時も snapshot を除外し、未完了 close を再試行する', async () => {
    const failure = new Error('close failed');
    let closeCount = 0;
    const h = createHarness({
      closeLane: async () => {
        closeCount += 1;
        if (closeCount === 1) throw failure;
      },
    });
    let notificationCount = 0;
    h.registry.onChange(() => {
      notificationCount += 1;
    });

    await expect(h.service.removeLane('api' as LaneId)).rejects.toBe(failure);

    expect(h.registry.snapshot().byId.has('api' as LaneId)).toBe(false);
    expect(notificationCount).toBe(1);
    expect(h.editorRemove).toHaveBeenCalledOnce();
    expect(h.editorRemove).toHaveBeenCalledWith('api');
    expect(h.effectEvents).toEqual(['close', 'remove']);

    await h.service.finalizePendingOperations();
    expect(h.effectEvents).toEqual(['close', 'remove', 'close']);
  });

  it('remove は snapshot 除外の永続化を待ってから catalog を公開する', async () => {
    const pending = deferred();
    const removeStarted = deferred();
    let completed = false;
    const h = createHarness({
      removeSnapshot: () => {
        removeStarted.resolve();
        return pending.promise;
      },
    });

    const removing = h.service.removeLane('api' as LaneId).then(() => {
      completed = true;
    });
    await removeStarted.promise;

    expect(h.effectEvents).toEqual(['close', 'remove']);
    expect(completed).toBe(false);
    expect(h.registry.snapshot().byId.has('api' as LaneId)).toBe(true);

    pending.resolve();
    await removing;
    expect(h.registry.snapshot().byId.has('api' as LaneId)).toBe(false);
  });

  it('snapshot 除外失敗は catalog 公開後に返し、未完了 snapshot だけを再試行する', async () => {
    const failure = new Error('snapshot remove failed');
    let removeCount = 0;
    const h = createHarness({
      removeSnapshot: async () => {
        removeCount += 1;
        if (removeCount === 1) throw failure;
      },
    });

    await expect(h.service.removeLane('api' as LaneId)).rejects.toBe(failure);
    expect(h.registry.snapshot().byId.has('api' as LaneId)).toBe(false);
    expect(h.effectEvents).toEqual(['close', 'remove']);

    await h.service.finalizePendingOperations();
    expect(h.effectEvents).toEqual(['close', 'remove', 'remove']);
  });

  it('terminal と snapshot の両方の失敗を保持し、両方を再試行する', async () => {
    const closeFailure = new Error('close failed');
    const removeFailure = new Error('snapshot remove failed');
    let fail = true;
    const h = createHarness({
      closeLane: async () => {
        if (fail) throw closeFailure;
      },
      removeSnapshot: async () => {
        if (fail) throw removeFailure;
      },
    });

    const removing = h.service.removeLane('api' as LaneId);
    await expect(removing).rejects.toBeInstanceOf(AggregateError);
    await expect(removing).rejects.toMatchObject({
      errors: [closeFailure, removeFailure],
    });
    expect(h.registry.snapshot().byId.has('api' as LaneId)).toBe(false);
    expect(h.effectEvents).toEqual(['close', 'remove']);

    fail = false;
    await h.service.finalizePendingOperations();
    expect(h.effectEvents).toEqual(['close', 'remove', 'close', 'remove']);
  });
});
