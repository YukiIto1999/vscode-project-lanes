import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { FolderMutation, WorkspaceFileInfo, WorkspaceFolder } from './model';
import type {
  CatalogStorePort,
  DirectoryPort,
  WorkspaceHostPort,
  WorkspaceLinkPort,
} from './ports';
import {
  bootstrapWorkspace,
  chooseActiveLane,
  collectLaneCandidates,
  isLegacyAnchor,
  isLinkFolder,
} from './scanner';

const toUri = (path: string) => `file://${path}` as UriString;
const mkFolder = (name: string, path: string): WorkspaceFolder => ({ name, uri: toUri(path) });

const fileInfo: WorkspaceFileInfo = {
  uri: toUri('/home/user/workspace.code-workspace'),
  directoryPath: '/home/user' as AbsolutePath,
};
const linkPath = '/home/user/.lanes-root/active' as AbsolutePath;
const linkFolder = mkFolder('web', linkPath);

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('isLegacyAnchor', () => {
  it('`.lanes-root` は true', () => {
    expect(isLegacyAnchor(mkFolder('.lanes-root', '/home/user/.lanes-root'))).toBe(true);
  });
  it('他の名前は false', () => {
    expect(isLegacyAnchor(mkFolder('web', '/home/user/web'))).toBe(false);
  });
});

describe('isLinkFolder', () => {
  it('linkPath と一致するパスは true', () => {
    expect(isLinkFolder(linkFolder, linkPath)).toBe(true);
  });
  it('異なるパスは false', () => {
    expect(isLinkFolder(mkFolder('web', '/home/user/web'), linkPath)).toBe(false);
  });
});

describe('collectLaneCandidates', () => {
  const stored: readonly WorkspaceFolder[] = [
    mkFolder('web', '/home/user/web'),
    mkFolder('api', '/home/user/api'),
  ];

  it('stored 無しで rawFolders から新旧アンカー除外', () => {
    const raw = [
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      linkFolder,
      mkFolder('web', '/home/user/web'),
    ];
    expect(collectLaneCandidates(raw, undefined, linkPath)).toEqual([
      mkFolder('web', '/home/user/web'),
    ]);
  });

  it('stored あれば stored を正本とし、rawFolders の追加を吸収', () => {
    const raw = [
      linkFolder,
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
      mkFolder('new', '/home/user/new'),
    ];
    expect(collectLaneCandidates(raw, stored, linkPath).map((f) => f.name)).toEqual([
      'web',
      'api',
      'new',
    ]);
  });

  it('rawFolders が symlink folder のみなら stored そのまま', () => {
    const raw = [linkFolder];
    expect(collectLaneCandidates(raw, stored, linkPath)).toEqual(stored);
  });

  it('stored が空でも rawFolders の通常 folder を候補にする', () => {
    const raw = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    expect(collectLaneCandidates(raw, [], linkPath)).toEqual(raw);
  });
});

describe('chooseActiveLane', () => {
  const lanes = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];

  it('空 lanes なら undefined', () => {
    expect(chooseActiveLane([], undefined)).toBeUndefined();
  });
  it('currentLinkTarget が lanes 内なら一致レーンを返す', () => {
    expect(chooseActiveLane(lanes, '/home/user/api' as AbsolutePath)?.name).toBe('api');
  });
  it('currentLinkTarget が lanes 外なら先頭レーンを返す', () => {
    expect(chooseActiveLane(lanes, '/home/user/unknown' as AbsolutePath)?.name).toBe('web');
  });
  it('currentLinkTarget 無しなら先頭レーン', () => {
    expect(chooseActiveLane(lanes, undefined)?.name).toBe('web');
  });
});

describe('bootstrapWorkspace', () => {
  const sameFolders = (
    left: readonly WorkspaceFolder[],
    right: readonly WorkspaceFolder[],
  ): boolean =>
    left.length === right.length &&
    left.every(
      (folder, index) => folder.uri === right[index]!.uri && folder.name === right[index]!.name,
    );

  const makeHost = (
    folders: WorkspaceFolder[],
    accepted = true,
    events: string[] | undefined = undefined,
  ) => {
    let current = folders;
    const mutations: FolderMutation[] = [];
    const port: WorkspaceHostPort = {
      readFolders: () => current,
      applyMutation: async (m) => {
        events?.push('mutation');
        mutations.push(m);
        if (!sameFolders(current, m.expectedFolders)) return false;
        if (!accepted) return false;
        const next = [...current];
        next.splice(m.start, m.deleteCount, ...m.folders);
        current = next;
        return true;
      },
    };
    return {
      port,
      mutations,
      replaceFolders: (next: WorkspaceFolder[]) => {
        current = next;
      },
      snapshot: () => current,
    };
  };

  const makeLink = (
    initialTarget: AbsolutePath | undefined,
    events: string[] | undefined = undefined,
  ) => {
    let target = initialTarget;
    const swaps: AbsolutePath[] = [];
    const port: WorkspaceLinkPort = {
      linkPath,
      readTarget: () => target,
      swap: (t) => {
        events?.push('link');
        swaps.push(t);
        target = t;
      },
      clear: () => {
        target = undefined;
      },
    };
    return {
      port,
      swaps,
      get target() {
        return target;
      },
    };
  };

  const makeCatalogStore = (
    initial: readonly WorkspaceFolder[] | undefined,
    persist: (folders: readonly WorkspaceFolder[]) => Promise<void> = async () => {},
    events: string[] | undefined = undefined,
  ) => {
    let stored: readonly WorkspaceFolder[] | undefined = initial;
    const port: CatalogStorePort = {
      load: () => stored,
      save: async (folders) => {
        events?.push('save');
        await persist(folders);
        stored = folders;
      },
    };
    return { port, saved: () => stored };
  };

  const okDir: DirectoryPort = { ensureDirectory: () => true };
  const failDir: DirectoryPort = { ensureDirectory: () => false };
  const makeDirectory = (available: boolean, events: string[]): DirectoryPort => ({
    ensureDirectory: () => {
      events.push('anchor');
      return available;
    },
  });

  it('アンカーディレクトリ作成失敗で missing-anchor', async () => {
    const host = makeHost([mkFolder('web', '/home/user/web')]);
    const link = makeLink(undefined);
    const store = makeCatalogStore(undefined);
    const result = await bootstrapWorkspace(
      host.port,
      fileInfo,
      store.port,
      failDir,
      link.port,
      toUri,
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
  });

  it('複数 folder で stored 無しの初回起動: symlink 作成 + folders 縮退', async () => {
    const host = makeHost([mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')]);
    const link = makeLink(undefined);
    const store = makeCatalogStore(undefined);
    const result = await bootstrapWorkspace(
      host.port,
      fileInfo,
      store.port,
      okDir,
      link.port,
      toUri,
    );
    expect(result.kind).toBe('ready');
    expect(link.swaps).toEqual(['/home/user/web']);
    expect(host.snapshot()).toHaveLength(1);
    expect(host.snapshot()[0]!.uri).toBe(toUri(linkPath));
    expect(host.snapshot()[0]!.name).toBe('web');
    expect(store.saved()?.map((f) => f.name)).toEqual(['web', 'api']);
  });

  it('`.lanes-root` を含む旧アンカー構造からも同じ最終状態へ移行', async () => {
    const host = makeHost([
      mkFolder('.lanes-root', '/home/user/.lanes-root'),
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
    const link = makeLink(undefined);
    const store = makeCatalogStore(undefined);
    await bootstrapWorkspace(host.port, fileInfo, store.port, okDir, link.port, toUri);
    expect(host.snapshot()).toHaveLength(1);
    expect(host.snapshot()[0]!.uri).toBe(toUri(linkPath));
    expect(link.swaps).toEqual(['/home/user/web']);
  });

  it('symlink folder 1 件 + target 正常の新構造なら folders 変更不要', async () => {
    const host = makeHost([linkFolder]);
    const link = makeLink('/home/user/web' as AbsolutePath);
    const store = makeCatalogStore([mkFolder('web', '/home/user/web')]);
    await bootstrapWorkspace(host.port, fileInfo, store.port, okDir, link.port, toUri);
    expect(host.mutations).toHaveLength(0);
    expect(link.swaps).toHaveLength(0);
  });

  it('未保存でレーン候補も無ければ副作用なしで missing-lane-source', async () => {
    const events: string[] = [];
    const host = makeHost([], true, events);
    const link = makeLink(undefined, events);
    const store = makeCatalogStore(undefined, async () => {}, events);
    const result = await bootstrapWorkspace(
      host.port,
      fileInfo,
      store.port,
      makeDirectory(true, events),
      link.port,
      toUri,
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'missing-lane-source' });
    expect(events).toEqual([]);
    expect(store.saved()).toBeUndefined();
    expect(link.swaps).toHaveLength(0);
    expect(host.mutations).toHaveLength(0);
  });

  it('保存済み空 catalog は保存後に anchor を確保して空のまま ready', async () => {
    const events: string[] = [];
    const host = makeHost([], true, events);
    const link = makeLink(undefined, events);
    const store = makeCatalogStore([], async () => {}, events);
    const result = await bootstrapWorkspace(
      host.port,
      fileInfo,
      store.port,
      makeDirectory(true, events),
      link.port,
      toUri,
    );
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.context.canonicalLanes).toEqual([]);
    expect(events).toEqual(['save', 'anchor']);
    expect(store.saved()).toEqual([]);
    expect(link.swaps).toHaveLength(0);
    expect(host.mutations).toHaveLength(0);
  });

  it('catalog 保存完了まで anchor、link、folders 変更を始めない', async () => {
    const events: string[] = [];
    const pending = deferred();
    const raw = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const host = makeHost(raw, true, events);
    const link = makeLink(undefined, events);
    const store = makeCatalogStore([], () => pending.promise, events);

    const bootstrapping = bootstrapWorkspace(
      host.port,
      fileInfo,
      store.port,
      makeDirectory(true, events),
      link.port,
      toUri,
    );
    await Promise.resolve();

    expect(events).toEqual(['save']);
    expect(link.swaps).toHaveLength(0);
    expect(host.snapshot()).toEqual(raw);

    pending.resolve();
    await expect(bootstrapping).resolves.toMatchObject({ kind: 'ready' });
    expect(events).toEqual(['save', 'anchor', 'link', 'mutation']);
    expect(store.saved()).toEqual(raw);
  });

  it.each([
    [
      '追加',
      [mkFolder('web', '/home/user/web')],
      [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')],
    ],
    [
      '削除',
      [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')],
      [mkFolder('web', '/home/user/web')],
    ],
  ])(
    'catalog 保存待機中に folders が%sされれば初期 snapshot の縮退を拒否',
    async (_change, raw, changed) => {
      const events: string[] = [];
      const pending = deferred();
      const host = makeHost(raw, true, events);
      const link = makeLink(undefined, events);
      const store = makeCatalogStore([], () => pending.promise, events);

      const bootstrapping = bootstrapWorkspace(
        host.port,
        fileInfo,
        store.port,
        makeDirectory(true, events),
        link.port,
        toUri,
      );
      await Promise.resolve();
      expect(events).toEqual(['save']);

      host.replaceFolders(changed);
      pending.resolve();

      await expect(bootstrapping).resolves.toEqual({
        kind: 'disabled',
        reason: 'workspace-folder-mutation-rejected',
      });
      expect(events).toEqual(['save', 'anchor', 'link', 'mutation']);
      expect(store.saved()).toEqual(raw);
      expect(link.target).toBe('/home/user/web');
      expect(host.snapshot()).toEqual(changed);
      expect(host.mutations[0]).toMatchObject({
        expectedFolders: raw,
        deleteCount: raw.length,
      });
    },
  );

  it('catalog 保存失敗を伝播し、後続副作用を実行しない', async () => {
    const events: string[] = [];
    const failure = new Error('save failed');
    const raw = [mkFolder('web', '/home/user/web')];
    const host = makeHost(raw, true, events);
    const link = makeLink(undefined, events);
    const store = makeCatalogStore(undefined, () => Promise.reject(failure), events);

    await expect(
      bootstrapWorkspace(
        host.port,
        fileInfo,
        store.port,
        makeDirectory(true, events),
        link.port,
        toUri,
      ),
    ).rejects.toBe(failure);
    expect(events).toEqual(['save']);
    expect(store.saved()).toBeUndefined();
    expect(link.swaps).toHaveLength(0);
    expect(host.snapshot()).toEqual(raw);
  });

  it('anchor 確保失敗は catalog 保存後に missing-anchor を返す', async () => {
    const events: string[] = [];
    const raw = [mkFolder('web', '/home/user/web')];
    const host = makeHost(raw, true, events);
    const link = makeLink(undefined, events);
    const store = makeCatalogStore(undefined, async () => {}, events);

    const result = await bootstrapWorkspace(
      host.port,
      fileInfo,
      store.port,
      makeDirectory(false, events),
      link.port,
      toUri,
    );

    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
    expect(events).toEqual(['save', 'anchor']);
    expect(store.saved()).toEqual(raw);
    expect(link.swaps).toHaveLength(0);
    expect(host.snapshot()).toEqual(raw);
  });

  it('folders 変更拒否時は保存済み catalog と交換済み link を残して disabled', async () => {
    const events: string[] = [];
    const raw = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const host = makeHost(raw, false, events);
    const link = makeLink(undefined, events);
    const store = makeCatalogStore(undefined, async () => {}, events);

    const result = await bootstrapWorkspace(
      host.port,
      fileInfo,
      store.port,
      makeDirectory(true, events),
      link.port,
      toUri,
    );

    expect(result).toEqual({
      kind: 'disabled',
      reason: 'workspace-folder-mutation-rejected',
    });
    expect(events).toEqual(['save', 'anchor', 'link', 'mutation']);
    expect(store.saved()).toEqual(raw);
    expect(link.target).toBe('/home/user/web');
    expect(host.snapshot()).toEqual(raw);
  });

  it('stored target が欠落した状態では lanes[0] にフォールバック', async () => {
    const host = makeHost([linkFolder]);
    const link = makeLink('/home/user/deleted' as AbsolutePath);
    const store = makeCatalogStore([
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
    await bootstrapWorkspace(host.port, fileInfo, store.port, okDir, link.port, toUri);
    expect(link.swaps).toEqual(['/home/user/web']);
  });
});
