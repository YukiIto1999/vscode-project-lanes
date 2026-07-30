import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import { createOperationQueue } from '../foundation/operation-queue';
import type { WorkspaceFolder } from './model';
import type { WorkspaceHostPort } from './ports';
import { createWorkspaceFolderReconciler, reconcileUserChange } from './reconciler';

const linkPath = '/ws/.lanes-root/active' as AbsolutePath;
const linkUri = `file://${linkPath}` as UriString;
const legacyAnchorUri = 'file:///ws/.lanes-root' as UriString;
const toUri = (p: string) => `file://${p}` as UriString;
const mkFolder = (name: string, path: string): WorkspaceFolder => ({ name, uri: toUri(path) });

const baseInput = {
  linkPath,
  activeLabel: 'web',
  linkUri,
  legacyAnchorUri,
};

describe('reconcileUserChange', () => {
  it('workspaceFolders が symlink folder 1 件なら noop', () => {
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [{ name: 'web', uri: linkUri }],
      currentLanes: [mkFolder('web', '/p/web')],
    });
    expect(result).toEqual({ kind: 'noop' });
  });

  it('ユーザーが未知フォルダを追加 → absorb に additions', () => {
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [{ name: 'web', uri: linkUri }, mkFolder('new', '/p/new')],
      currentLanes: [mkFolder('web', '/p/web')],
    });
    expect(result.kind).toBe('absorb');
    if (result.kind !== 'absorb') return;
    expect(result.additions.map((f) => f.name)).toEqual(['new']);
    expect(result.collapsedFolder).toEqual({ uri: linkUri, name: 'web' });
  });

  it('既知レーンを追加しても additions は空', () => {
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [{ name: 'web', uri: linkUri }, mkFolder('api', '/p/api')],
      currentLanes: [mkFolder('web', '/p/web'), mkFolder('api', '/p/api')],
    });
    expect(result.kind).toBe('absorb');
    if (result.kind !== 'absorb') return;
    expect(result.additions).toEqual([]);
  });

  it('旧アンカー URI が紛れ込んでも表示名にかかわらず除外される', () => {
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [
        mkFolder('renamed-anchor', '/ws/.lanes-root'),
        { name: 'web', uri: linkUri },
        mkFolder('new', '/p/new'),
      ],
      currentLanes: [],
    });
    expect(result.kind).toBe('absorb');
    if (result.kind !== 'absorb') return;
    expect(result.additions.map((f) => f.name)).toEqual(['new']);
  });

  it('表示名が `.lanes-root` の実レーンを additions に残す', () => {
    const realLane = mkFolder('.lanes-root', '/p/.lanes-root');
    const result = reconcileUserChange({
      ...baseInput,
      rawFolders: [{ name: 'web', uri: linkUri }, realLane],
      currentLanes: [],
    });
    expect(result.kind).toBe('absorb');
    if (result.kind !== 'absorb') return;
    expect(result.additions).toEqual([realLane]);
  });
});

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('createWorkspaceFolderReconciler', () => {
  it('pending operation を確定してから最新 folders を読み noop を返す', async () => {
    const gate = deferred();
    const events: string[] = [];
    let rawFolders: readonly WorkspaceFolder[] = [mkFolder('stale', '/p/stale')];
    const workspaceHost: WorkspaceHostPort = {
      readFolders: () => {
        events.push('read');
        return rawFolders;
      },
      applyMutation: async () => {
        throw new Error('noop must not mutate workspace folders');
      },
    };
    const reconciler = createWorkspaceFolderReconciler({
      operationQueue: createOperationQueue(),
      workspaceHost,
      getCurrentLanes: () => [mkFolder('web', '/p/web')],
      getActiveLabel: () => 'web',
      absorb: async () => {
        throw new Error('noop must not absorb lanes');
      },
      finalizePendingOperations: async () => {
        events.push('finalize:start');
        await gate.promise;
        events.push('finalize:end');
      },
      linkPath,
      linkUri,
      legacyAnchorUri,
    });

    const pending = reconciler.reconcileWorkspaceFolders();
    await Promise.resolve();
    rawFolders = [{ name: 'web', uri: linkUri }];
    expect(events).toEqual(['finalize:start']);

    gate.resolve();
    await expect(pending).resolves.toEqual({ kind: 'noop' });
    expect(events).toEqual(['finalize:start', 'finalize:end', 'read']);
  });

  it('catalog への取込完了後に計画時 snapshot を単一 link folder へ縮退する', async () => {
    const absorbStarted = deferred();
    const saveGate = deferred();
    const events: string[] = [];
    const rawFolders = [{ name: 'web', uri: linkUri }, mkFolder('api', '/p/api')];
    let mutation: Parameters<WorkspaceHostPort['applyMutation']>[0] | undefined;
    const workspaceHost: WorkspaceHostPort = {
      readFolders: () => rawFolders,
      applyMutation: async (next) => {
        events.push('collapse');
        mutation = next;
        return true;
      },
    };
    const reconciler = createWorkspaceFolderReconciler({
      operationQueue: createOperationQueue(),
      workspaceHost,
      getCurrentLanes: () => [mkFolder('web', '/p/web')],
      getActiveLabel: () => 'web',
      absorb: async (additions) => {
        events.push(`absorb:${additions.map((folder) => folder.name).join(',')}`);
        absorbStarted.resolve();
        await saveGate.promise;
      },
      finalizePendingOperations: async () => undefined,
      linkPath,
      linkUri,
      legacyAnchorUri,
    });

    const pending = reconciler.reconcileWorkspaceFolders();
    await absorbStarted.promise;
    expect(events).toEqual(['absorb:api']);

    saveGate.resolve();
    await expect(pending).resolves.toEqual({ kind: 'collapsed' });
    expect(events).toEqual(['absorb:api', 'collapse']);
    expect(mutation).toEqual({
      expectedFolders: rawFolders,
      start: 0,
      deleteCount: 2,
      folders: [{ name: 'web', uri: linkUri }],
    });
  });

  it('folder mutation の false を rejected として返し吸収済み catalog を維持する', async () => {
    const rawFolders = [{ name: 'web', uri: linkUri }, mkFolder('api', '/p/api')];
    let currentLanes: readonly WorkspaceFolder[] = [mkFolder('web', '/p/web')];
    const reconciler = createWorkspaceFolderReconciler({
      operationQueue: createOperationQueue(),
      workspaceHost: {
        readFolders: () => rawFolders,
        applyMutation: async () => false,
      },
      getCurrentLanes: () => currentLanes,
      getActiveLabel: () => 'web',
      absorb: async (additions) => {
        currentLanes = [...currentLanes, ...additions];
      },
      finalizePendingOperations: async () => undefined,
      linkPath,
      linkUri,
      legacyAnchorUri,
    });

    await expect(reconciler.reconcileWorkspaceFolders()).resolves.toEqual({ kind: 'rejected' });
    expect(currentLanes.map((folder) => folder.name)).toEqual(['web', 'api']);
  });

  it('folder mutation の reject を伝播し吸収済み catalog を維持する', async () => {
    const failure = new Error('workspace mutation failed');
    const rawFolders = [{ name: 'web', uri: linkUri }, mkFolder('api', '/p/api')];
    let currentLanes: readonly WorkspaceFolder[] = [mkFolder('web', '/p/web')];
    const reconciler = createWorkspaceFolderReconciler({
      operationQueue: createOperationQueue(),
      workspaceHost: {
        readFolders: () => rawFolders,
        applyMutation: async () => Promise.reject(failure),
      },
      getCurrentLanes: () => currentLanes,
      getActiveLabel: () => 'web',
      absorb: async (additions) => {
        currentLanes = [...currentLanes, ...additions];
      },
      finalizePendingOperations: async () => undefined,
      linkPath,
      linkUri,
      legacyAnchorUri,
    });

    await expect(reconciler.reconcileWorkspaceFolders()).rejects.toBe(failure);
    expect(currentLanes.map((folder) => folder.name)).toEqual(['web', 'api']);
  });

  it('拒否後の再試行では同じ lane を重複吸収せず縮退する', async () => {
    const rawFolders = [{ name: 'web', uri: linkUri }, mkFolder('api', '/p/api')];
    let currentLanes: readonly WorkspaceFolder[] = [mkFolder('web', '/p/web')];
    const absorbed: string[][] = [];
    let mutationCount = 0;
    const reconciler = createWorkspaceFolderReconciler({
      operationQueue: createOperationQueue(),
      workspaceHost: {
        readFolders: () => rawFolders,
        applyMutation: async () => {
          mutationCount += 1;
          return mutationCount > 1;
        },
      },
      getCurrentLanes: () => currentLanes,
      getActiveLabel: () => 'web',
      absorb: async (additions) => {
        absorbed.push(additions.map((folder) => folder.name));
        currentLanes = [...currentLanes, ...additions];
      },
      finalizePendingOperations: async () => undefined,
      linkPath,
      linkUri,
      legacyAnchorUri,
    });

    await expect(reconciler.reconcileWorkspaceFolders()).resolves.toEqual({ kind: 'rejected' });
    await expect(reconciler.reconcileWorkspaceFolders()).resolves.toEqual({ kind: 'collapsed' });
    expect(absorbed).toEqual([['api'], []]);
    expect(currentLanes.map((folder) => folder.name)).toEqual(['web', 'api']);
  });

  it('失敗後も runtime 共通 queue の後続再整合を実行する', async () => {
    const failure = new Error('first mutation failed');
    const rawFolders = [{ name: 'web', uri: linkUri }, mkFolder('api', '/p/api')];
    let mutationCount = 0;
    const reconciler = createWorkspaceFolderReconciler({
      operationQueue: createOperationQueue(),
      workspaceHost: {
        readFolders: () => rawFolders,
        applyMutation: async () => {
          mutationCount += 1;
          if (mutationCount === 1) throw failure;
          return true;
        },
      },
      getCurrentLanes: () => [mkFolder('web', '/p/web'), mkFolder('api', '/p/api')],
      getActiveLabel: () => 'web',
      absorb: async () => undefined,
      finalizePendingOperations: async () => undefined,
      linkPath,
      linkUri,
      legacyAnchorUri,
    });

    await expect(reconciler.reconcileWorkspaceFolders()).rejects.toBe(failure);
    await expect(reconciler.reconcileWorkspaceFolders()).resolves.toEqual({ kind: 'collapsed' });
    expect(mutationCount).toBe(2);
  });
});
