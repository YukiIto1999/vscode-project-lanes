import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';
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

const createHarness = ({
  saveCatalog = async () => {},
  closeLane = async () => {},
}: {
  readonly saveCatalog?: CatalogStorePort['save'];
  readonly closeLane?: LaneTerminalPort['closeLane'];
} = {}) => {
  const initial = [toFolder('web'), toFolder('api')];
  const store: CatalogStorePort = {
    load: () => initial,
    save: saveCatalog,
  };
  const registry = createCatalogRegistry(initial, store);
  const selectionSave = vi.fn<LaneSelectionStorePort['save']>();
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
    revealLane: async () => {},
    closeLane: terminalClose,
  };
  const terminalRekey = vi.fn<(oldId: LaneId, newId: LaneId) => void>();
  const editorRekey = vi.fn<LaneSessionStore['rekey']>();
  const editorClear = vi.fn<LaneSessionStore['clear']>(() => {
    effectEvents.push('clear');
  });
  const editorStore: LaneSessionStore = {
    save: () => {},
    get: () => undefined,
    rekey: editorRekey,
    clear: editorClear,
  };
  const editor: EditorPort = {
    hasDirtyEditors: () => false,
    captureSnapshot: () => ({ tabs: [] }),
    closeAll: async () => {},
    restoreSnapshot: async () => {},
  };
  const viewRebind = vi.fn<LaneViewRebindPort['rebindActiveFolder']>(async () => {});
  const prompt: LanePromptPort = {
    pickLane: async () => undefined,
    warnDirtyEditors: () => {},
    promptRename: async () => 'frontend',
    confirmRemoval: async () => true,
    warnActiveLaneRemoval: () => {},
    pickFoldersToAdd: async () => [],
    warnAddFolderFailed: () => {},
  };
  const service = createLaneService({
    getCatalog: () => registry.snapshot(),
    workspaceKey,
    editor,
    link: {
      linkPath,
      readTarget: () => undefined,
      swap: () => {},
    },
    terminal,
    viewRebind: { rebindActiveFolder: viewRebind },
    selectionStore,
    prompt,
    registry,
    terminalRekey: { rekeyLane: terminalRekey },
    editorStore,
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
  };
};

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
