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
import { createLaneService } from './service';

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
  saveCatalog = async () => {},
  closeLane = async () => {},
  revealLane = async () => {},
  pickLane = async () => undefined,
  promptRename = async () => 'frontend',
  confirmRemoval = async () => true,
  operationQueue: operationQueueOverride,
  rebindActiveFolder = async () => true,
  linkTarget = '/repo/web' as AbsolutePath,
  warnDirtyEditors = () => {},
  saveSelection = async () => {},
  rekeyTerminal = () => {},
  rekeyEditor = () => {},
}: {
  readonly saveCatalog?: CatalogStorePort['save'];
  readonly closeLane?: LaneTerminalPort['closeLane'];
  readonly revealLane?: LaneTerminalPort['revealLane'];
  readonly pickLane?: LanePromptPort['pickLane'];
  readonly promptRename?: LanePromptPort['promptRename'];
  readonly confirmRemoval?: LanePromptPort['confirmRemoval'];
  readonly operationQueue?: OperationQueue;
  readonly rebindActiveFolder?: LaneViewRebindPort['rebindActiveFolder'];
  readonly linkTarget?: AbsolutePath;
  readonly warnDirtyEditors?: LanePromptPort['warnDirtyEditors'];
  readonly saveSelection?: LaneSelectionStorePort['save'];
  readonly rekeyTerminal?: (oldId: LaneId, newId: LaneId) => void;
  readonly rekeyEditor?: LaneSessionStore['rekey'];
} = {}) => {
  const initial = [toFolder('web'), toFolder('api')];
  const store: CatalogStorePort = {
    load: () => initial,
    save: saveCatalog,
  };
  const registry = createCatalogRegistry(initial, store);
  const selectionSave = vi.fn<LaneSelectionStorePort['save']>(saveSelection);
  const selectionStore: LaneSelectionStorePort = {
    load: () => 'web' as LaneId,
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
  let currentLinkTarget = linkTarget;
  const service = createLaneService({
    getCatalog: () => registry.snapshot(),
    workspaceKey,
    editor,
    link: {
      linkPath,
      readTarget: () => currentLinkTarget,
      swap: (target) => {
        currentLinkTarget = target;
      },
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
    selectionSave,
    terminalClose,
    terminalRekey,
    editorRekey,
    editorClear,
    effectEvents,
    viewRebind,
    editorClose,
    operationEnqueueCount: () => operationEnqueueCount,
  };
};

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

    await expect(h.service.renameLane('web' as LaneId)).rejects.toBe(failure);

    expect(h.terminalRekey).not.toHaveBeenCalled();
    expect(h.editorRekey).not.toHaveBeenCalled();
    expect(h.selectionSave).not.toHaveBeenCalled();
    expect(h.service.snapshot().activeLaneId).toBe('web');
    expect(h.viewRebind).not.toHaveBeenCalled();
  });

  it('rename listener は rekey と active selection 更新後の状態を観測', async () => {
    const h = createHarness();
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
        return rebindCount > 1;
      },
    });

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
