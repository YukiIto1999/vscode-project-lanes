import { describe, expect, it } from 'vitest';
import type { AbsolutePath, UriString } from '../foundation/model';
import type { WorkspaceFileInfo, WorkspaceFolder } from './model';
import type {
  CatalogStorePort,
  DirectoryPort,
  WorkspaceHostPort,
  WorkspaceLinkPort,
} from './ports';
import {
  bootstrapWorkspace,
  collapseFoldersToLink,
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
const legacyAnchorUri = toUri('/home/user/.lanes-root');
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
  it('旧 anchor URI と一致すれば表示名にかかわらず true', () => {
    expect(
      isLegacyAnchor(mkFolder('renamed-anchor', '/home/user/.lanes-root'), legacyAnchorUri),
    ).toBe(true);
  });
  it('表示名が `.lanes-root` でも URI が異なる実レーンは false', () => {
    expect(
      isLegacyAnchor(mkFolder('.lanes-root', '/home/user/projects/.lanes-root'), legacyAnchorUri),
    ).toBe(false);
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
      mkFolder('renamed-anchor', '/home/user/.lanes-root'),
      linkFolder,
      mkFolder('web', '/home/user/web'),
    ];
    expect(collectLaneCandidates(raw, undefined, linkPath, legacyAnchorUri)).toEqual([
      mkFolder('web', '/home/user/web'),
    ]);
  });

  it('表示名が `.lanes-root` の実レーンを候補に残す', () => {
    const realLane = mkFolder('.lanes-root', '/home/user/projects/.lanes-root');
    expect(collectLaneCandidates([realLane], undefined, linkPath, legacyAnchorUri)).toEqual([
      realLane,
    ]);
  });

  it('stored あれば stored を正本とし、rawFolders の追加を吸収', () => {
    const raw = [
      linkFolder,
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
      mkFolder('new', '/home/user/new'),
    ];
    expect(
      collectLaneCandidates(raw, stored, linkPath, legacyAnchorUri).map((f) => f.name),
    ).toEqual(['web', 'api', 'new']);
  });

  it('rawFolders が symlink folder のみなら stored そのまま', () => {
    const raw = [linkFolder];
    expect(collectLaneCandidates(raw, stored, linkPath, legacyAnchorUri)).toEqual(stored);
  });

  it('stored が空でも rawFolders の通常 folder を候補にする', () => {
    const raw = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    expect(collectLaneCandidates(raw, [], linkPath, legacyAnchorUri)).toEqual(raw);
  });
});

describe('collapseFoldersToLink', () => {
  it('計画時 snapshot を含む単一 mutation を適用する', async () => {
    const raw = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const mutations: Parameters<WorkspaceHostPort['applyMutation']>[0][] = [];
    const host: WorkspaceHostPort = {
      readFolders: () => raw,
      applyMutation: async (mutation) => {
        mutations.push(mutation);
        return true;
      },
    };

    await expect(collapseFoldersToLink(host, raw, linkFolder)).resolves.toBe(true);
    expect(mutations).toEqual([
      {
        expectedFolders: raw,
        start: 0,
        deleteCount: raw.length,
        folders: [linkFolder],
      },
    ]);
  });
});

describe('bootstrapWorkspace', () => {
  const makeHost = (
    folders: readonly WorkspaceFolder[],
  ): Pick<WorkspaceHostPort, 'readFolders'> => ({
    readFolders: () => folders,
  });

  const forbiddenLink: WorkspaceLinkPort = {
    linkPath,
    readTarget: () => {
      throw new Error('bootstrapWorkspace must not read the active link target');
    },
    swap: () => {
      throw new Error('bootstrapWorkspace must not swap the active link');
    },
    clear: () => {
      throw new Error('bootstrapWorkspace must not clear the active link');
    },
  };
  const linkOnly: Pick<WorkspaceLinkPort, 'linkPath'> = { linkPath };

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

  it('raw folders と保存済み catalog の収集結果だけを返す', async () => {
    const raw = [
      linkFolder,
      mkFolder('api', '/home/user/api'),
      mkFolder('worker', '/home/user/worker'),
    ];
    const stored = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const store = makeCatalogStore(stored);

    const result = await bootstrapWorkspace(
      makeHost(raw),
      fileInfo,
      store.port,
      okDir,
      legacyAnchorUri,
      forbiddenLink,
    );

    expect(result).toEqual({
      kind: 'ready',
      context: {
        key: `workspace:${fileInfo.uri}`,
        canonicalLanes: [...stored, mkFolder('worker', '/home/user/worker')],
      },
    });
    expect(store.saved()).toEqual([...stored, mkFolder('worker', '/home/user/worker')]);
  });

  it('アンカーディレクトリ作成失敗で missing-anchor', async () => {
    const store = makeCatalogStore(undefined);
    const result = await bootstrapWorkspace(
      makeHost([mkFolder('web', '/home/user/web')]),
      fileInfo,
      store.port,
      failDir,
      legacyAnchorUri,
      forbiddenLink,
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
  });

  it('未保存でレーン候補も無ければ保存も anchor 確保もせず missing-lane-source', async () => {
    const events: string[] = [];
    const store = makeCatalogStore(undefined, async () => {}, events);
    const result = await bootstrapWorkspace(
      makeHost([]),
      fileInfo,
      store.port,
      makeDirectory(true, events),
      legacyAnchorUri,
      linkOnly,
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'missing-lane-source' });
    expect(events).toEqual([]);
    expect(store.saved()).toBeUndefined();
  });

  it('保存済み空 catalog は保存後に anchor を確保して空のまま ready', async () => {
    const events: string[] = [];
    const store = makeCatalogStore([], async () => {}, events);
    const result = await bootstrapWorkspace(
      makeHost([]),
      fileInfo,
      store.port,
      makeDirectory(true, events),
      legacyAnchorUri,
      linkOnly,
    );
    expect(result).toEqual({
      kind: 'ready',
      context: { key: `workspace:${fileInfo.uri}`, canonicalLanes: [] },
    });
    expect(events).toEqual(['save', 'anchor']);
    expect(store.saved()).toEqual([]);
  });

  it('catalog 保存完了まで anchor 確保を始めない', async () => {
    const events: string[] = [];
    const pending = deferred();
    const raw = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const store = makeCatalogStore([], () => pending.promise, events);

    const bootstrapping = bootstrapWorkspace(
      makeHost(raw),
      fileInfo,
      store.port,
      makeDirectory(true, events),
      legacyAnchorUri,
      linkOnly,
    );
    await Promise.resolve();

    expect(events).toEqual(['save']);

    pending.resolve();
    await expect(bootstrapping).resolves.toMatchObject({ kind: 'ready' });
    expect(events).toEqual(['save', 'anchor']);
    expect(store.saved()).toEqual(raw);
  });

  it('catalog 保存失敗を伝播し、anchor 確保を実行しない', async () => {
    const events: string[] = [];
    const failure = new Error('save failed');
    const raw = [mkFolder('web', '/home/user/web')];
    const store = makeCatalogStore(undefined, () => Promise.reject(failure), events);

    await expect(
      bootstrapWorkspace(
        makeHost(raw),
        fileInfo,
        store.port,
        makeDirectory(true, events),
        legacyAnchorUri,
        linkOnly,
      ),
    ).rejects.toBe(failure);
    expect(events).toEqual(['save']);
    expect(store.saved()).toBeUndefined();
  });

  it('anchor 確保失敗は catalog 保存後に missing-anchor を返す', async () => {
    const events: string[] = [];
    const raw = [mkFolder('web', '/home/user/web')];
    const store = makeCatalogStore(undefined, async () => {}, events);

    const result = await bootstrapWorkspace(
      makeHost(raw),
      fileInfo,
      store.port,
      makeDirectory(false, events),
      legacyAnchorUri,
      forbiddenLink,
    );

    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
    expect(events).toEqual(['save', 'anchor']);
    expect(store.saved()).toEqual(raw);
  });

  it('folder mutation の拒否結果を問い合わせず ready を返す', async () => {
    const raw = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    let mutationCalls = 0;
    const host: WorkspaceHostPort = {
      readFolders: () => raw,
      applyMutation: async () => {
        mutationCalls += 1;
        return false;
      },
    };
    const store = makeCatalogStore(undefined);
    const link: WorkspaceLinkPort = {
      linkPath,
      readTarget: () => '/home/user/web' as AbsolutePath,
      swap: () => {
        throw new Error('bootstrapWorkspace must not swap the active link');
      },
      clear: () => {
        throw new Error('bootstrapWorkspace must not clear the active link');
      },
    };

    const result = await bootstrapWorkspace(
      host,
      fileInfo,
      store.port,
      okDir,
      legacyAnchorUri,
      link,
    );

    expect(result).toMatchObject({ kind: 'ready' });
    expect(mutationCalls).toBe(0);
  });

  it.each([
    ['未作成', undefined],
    ['catalog 外', '/home/user/deleted' as AbsolutePath],
  ])('active link が%sでも読取、交換、削除をしない', async (_state, target) => {
    let reads = 0;
    const writes: string[] = [];
    const link: WorkspaceLinkPort = {
      linkPath,
      readTarget: () => {
        reads += 1;
        return target;
      },
      swap: () => {
        writes.push('swap');
      },
      clear: () => {
        writes.push('clear');
      },
    };
    const store = makeCatalogStore([mkFolder('web', '/home/user/web')]);

    await expect(
      bootstrapWorkspace(
        makeHost([linkFolder]),
        fileInfo,
        store.port,
        okDir,
        legacyAnchorUri,
        link,
      ),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(reads).toBe(0);
    expect(writes).toEqual([]);
  });
});
