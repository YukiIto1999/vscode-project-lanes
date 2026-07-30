import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { CatalogEntry, WorkspaceFileInfo, WorkspaceFolder } from './model';
import type { CatalogStorePort, DirectoryPort, WorkspaceHostPort } from './ports';
import { deriveWorkspaceAnchor } from './anchor';
import { bootstrapWorkspace, collapseFoldersToLink, collectLaneCandidates } from './scanner';

const toUri = (path: string) => `file://${path}` as UriString;
const mkFolder = (name: string, path: string): WorkspaceFolder => ({ name, uri: toUri(path) });
const canonicalId = (value: string): LaneId =>
  (/^[0-9a-f]{64}$/.test(value) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value
    : createHash('sha256').update(`scanner-test:${value}`).digest('hex')) as LaneId;
const mkEntry = (id: string, name: string, path: string) => ({
  id: canonicalId(id),
  name,
  uri: toUri(path),
});
const idFactory = (...ids: readonly string[]) => {
  let index = 0;
  return {
    next: () => {
      const id = ids[index];
      if (id === undefined) throw new Error('unexpected LaneId allocation');
      index += 1;
      return canonicalId(id);
    },
  };
};
const rawIdFactory = (id: string) => ({ next: () => id as LaneId });

const fileInfo: WorkspaceFileInfo = {
  uri: toUri('/home/user/workspace.code-workspace'),
  directoryPath: '/home/user' as AbsolutePath,
};
const anchor = deriveWorkspaceAnchor(fileInfo);
const linkPath = anchor.activeLinkPath;
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

describe('collectLaneCandidates', () => {
  const stored: readonly CatalogEntry[] = [
    mkEntry('web', 'web', '/home/user/web'),
    mkEntry('api', 'api', '/home/user/api'),
  ];

  it('stored 無しで rawFolders から新旧アンカー除外', () => {
    const raw = [
      mkFolder('renamed-anchor', '/home/user/.lanes-root'),
      mkFolder('legacy-active', anchor.legacyActiveLinkPath),
      linkFolder,
      mkFolder('web', '/home/user/web'),
    ];
    expect(collectLaneCandidates(raw, undefined, anchor, idFactory('web'))).toEqual([
      mkEntry('web', 'web', '/home/user/web'),
    ]);
  });

  it('表示名が `.lanes-root` の実レーンを候補に残す', () => {
    const realLane = mkFolder('.lanes-root', '/home/user/projects/.lanes-root');
    expect(collectLaneCandidates([realLane], undefined, anchor, idFactory('.lanes-root'))).toEqual([
      mkEntry('.lanes-root', '.lanes-root', '/home/user/projects/.lanes-root'),
    ]);
  });

  it('stored あれば stored を正本とし、rawFolders の追加を吸収', () => {
    const raw = [
      linkFolder,
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
      mkFolder('new', '/home/user/new'),
    ];
    expect(collectLaneCandidates(raw, stored, anchor, idFactory('new')).map((f) => f.name)).toEqual(
      ['web', 'api', 'new'],
    );
  });

  it('stored に誤登録された旧アンカーを除外し、同名の実レーンは残す', () => {
    const realLane = mkFolder('.lanes-root', '/home/user/projects/.lanes-root');
    const contaminatedStored = [
      mkEntry('anchor', 'renamed-anchor', '/home/user/.lanes-root'),
      mkEntry('real', realLane.name, '/home/user/projects/.lanes-root'),
    ];
    expect(collectLaneCandidates([linkFolder], contaminatedStored, anchor, idFactory())).toEqual([
      mkEntry('real', realLane.name, '/home/user/projects/.lanes-root'),
    ]);
  });

  it('rawFolders が symlink folder のみなら stored そのまま', () => {
    const raw = [linkFolder];
    expect(collectLaneCandidates(raw, stored, anchor, idFactory())).toEqual(stored);
  });

  it('stored が空でも rawFolders の通常 folder を候補にする', () => {
    const raw = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    expect(collectLaneCandidates(raw, [], anchor, idFactory('web', 'api'))).toEqual([
      mkEntry('web', 'web', '/home/user/web'),
      mkEntry('api', 'api', '/home/user/api'),
    ]);
  });

  it('stored ID を維持し、同名の新規 root だけに factory ID を割り当てる', () => {
    const storedEntry = mkEntry('4a79c5d0-2bb0-4d96-8870-98ce67fe9066', 'same', '/home/user/web');
    const newId = '9b2aa5a7-b9ab-49d9-aa66-86858603d845';

    expect(
      collectLaneCandidates(
        [mkFolder('host-renamed', '/home/user/web'), mkFolder('same', '/home/user/api')],
        [storedEntry],
        anchor,
        idFactory(newId),
      ),
    ).toEqual([storedEntry, mkEntry(newId, 'same', '/home/user/api')]);
  });

  it('stored の重複 root を暗黙に削除せず拒否する', () => {
    expect(() =>
      collectLaneCandidates(
        [linkFolder],
        [
          mkEntry('web', 'web', '/home/user/web'),
          mkEntry('web-copy', 'web-copy', '/home/user/web'),
        ],
        anchor,
        idFactory(),
      ),
    ).toThrow(/duplicate lane root/i);
  });

  it('stored の URI alias root も重複として拒否する', () => {
    expect(() =>
      collectLaneCandidates(
        [linkFolder],
        [
          mkEntry('web', 'web', '/home/user/my%20project'),
          mkEntry('web-copy', 'web-copy', '/home/user/my project'),
        ],
        anchor,
        idFactory(),
      ),
    ).toThrow(/duplicate lane root/i);
  });

  it('stored の末尾 separator alias root も重複として拒否する', () => {
    expect(() =>
      collectLaneCandidates(
        [linkFolder],
        [
          mkEntry('web', 'web', '/home/user/web/'),
          mkEntry('web-copy', 'web-copy', '/home/user/web'),
        ],
        anchor,
        idFactory(),
      ),
    ).toThrow(/duplicate lane root/i);
  });

  it('raw folder の URI alias は同じ既知 root として一度だけ採番する', () => {
    const allocated = idFactory('web');

    expect(
      collectLaneCandidates(
        [
          mkFolder('encoded', '/home/user/my%20project'),
          mkFolder('plain', '/home/user/my project'),
        ],
        undefined,
        anchor,
        allocated,
      ),
    ).toEqual([mkEntry('web', 'encoded', '/home/user/my%20project')]);
    expect(() => allocated.next()).toThrow(/unexpected LaneId allocation/);
  });

  it('raw folder の末尾 separator alias も一度だけ採番する', () => {
    const allocated = idFactory('web');

    expect(
      collectLaneCandidates(
        [mkFolder('with-slash', '/home/user/web/'), mkFolder('plain', '/home/user/web')],
        undefined,
        anchor,
        allocated,
      ),
    ).toEqual([mkEntry('web', 'with-slash', '/home/user/web/')]);
    expect(() => allocated.next()).toThrow(/unexpected LaneId allocation/);
  });

  it('factory が非 canonical ID を返したら拒否する', () => {
    expect(() =>
      collectLaneCandidates(
        [mkFolder('web', '/home/user/web')],
        undefined,
        anchor,
        rawIdFactory('web'),
      ),
    ).toThrow(/invalid LaneId/i);
  });

  it('factory が既存 ID を返したら拒否する', () => {
    const existingId = '4a79c5d0-2bb0-4d96-8870-98ce67fe9066';
    expect(() =>
      collectLaneCandidates(
        [mkFolder('api', '/home/user/api')],
        [mkEntry(existingId, 'web', '/home/user/web')],
        anchor,
        idFactory(existingId),
      ),
    ).toThrow(/duplicate LaneId/i);
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

  const generatedId = '4a79c5d0-2bb0-4d96-8870-98ce67fe9066';

  const makeCatalogStore = (
    initial: readonly CatalogEntry[] | undefined,
    persist: (folders: readonly CatalogEntry[]) => Promise<void> = async () => {},
    events: string[] | undefined = undefined,
  ) => {
    let stored: readonly CatalogEntry[] | undefined = initial;
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
    ensureDirectory: (path) => {
      events.push(path);
      return available;
    },
  });

  it('raw folders と保存済み catalog の収集結果だけを返す', async () => {
    const raw = [
      linkFolder,
      mkFolder('api', '/home/user/api'),
      mkFolder('worker', '/home/user/worker'),
    ];
    const stored = [
      mkEntry('web', 'web', '/home/user/web'),
      mkEntry('api', 'api', '/home/user/api'),
    ];
    const store = makeCatalogStore(stored);

    const result = await bootstrapWorkspace(
      makeHost(raw),
      fileInfo,
      store.port,
      okDir,
      idFactory('worker'),
    );

    expect(result).toEqual({
      kind: 'ready',
      context: {
        key: `workspace:${fileInfo.uri}`,
        canonicalLanes: [...stored, mkEntry('worker', 'worker', '/home/user/worker')],
      },
    });
    expect(store.saved()).toEqual([...stored, mkEntry('worker', 'worker', '/home/user/worker')]);
  });

  it('初回 raw folder に opaque ID を付与し、保存完了後に ready を返す', async () => {
    const events: string[] = [];
    const store = makeCatalogStore(undefined, async () => {}, events);

    const result = await bootstrapWorkspace(
      makeHost([mkFolder('web', '/home/user/web')]),
      fileInfo,
      store.port,
      okDir,
      idFactory(generatedId),
    );

    expect(events).toEqual(['save']);
    expect(store.saved()).toEqual([mkEntry(generatedId, 'web', '/home/user/web')]);
    expect(result).toEqual({
      kind: 'ready',
      context: {
        key: `workspace:${fileInfo.uri}`,
        canonicalLanes: [mkEntry(generatedId, 'web', '/home/user/web')],
      },
    });
  });

  it('factory の不正 ID は catalog を保存する前に拒否する', async () => {
    const events: string[] = [];
    const store = makeCatalogStore(undefined, async () => {}, events);

    await expect(
      bootstrapWorkspace(
        makeHost([mkFolder('web', '/home/user/web')]),
        fileInfo,
        store.port,
        okDir,
        rawIdFactory('web'),
      ),
    ).rejects.toThrow(/invalid LaneId/i);
    expect(events).toEqual([]);
    expect(store.saved()).toBeUndefined();
  });

  it('アンカーディレクトリ作成失敗で missing-anchor', async () => {
    const store = makeCatalogStore(undefined);
    const result = await bootstrapWorkspace(
      makeHost([mkFolder('web', '/home/user/web')]),
      fileInfo,
      store.port,
      failDir,
      idFactory('web'),
    );
    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
  });

  it('hash directory 作成失敗で missing-anchor', async () => {
    const store = makeCatalogStore(undefined);
    const ensured: AbsolutePath[] = [];
    const directory: DirectoryPort = {
      ensureDirectory: (path) => {
        ensured.push(path);
        return path === anchor.rootDirectoryPath;
      },
    };

    const result = await bootstrapWorkspace(
      makeHost([mkFolder('web', '/home/user/web')]),
      fileInfo,
      store.port,
      directory,
      idFactory('web'),
    );

    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
    expect(ensured).toEqual([anchor.rootDirectoryPath, anchor.namespaceDirectoryPath]);
  });

  it('未保存でレーン候補も無ければ保存も anchor 確保もせず missing-lane-source', async () => {
    const events: string[] = [];
    const store = makeCatalogStore(undefined, async () => {}, events);
    const result = await bootstrapWorkspace(
      makeHost([]),
      fileInfo,
      store.port,
      makeDirectory(true, events),
      idFactory(),
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
      idFactory(),
    );
    expect(result).toEqual({
      kind: 'ready',
      context: { key: `workspace:${fileInfo.uri}`, canonicalLanes: [] },
    });
    expect(events).toEqual(['save', anchor.rootDirectoryPath, anchor.namespaceDirectoryPath]);
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
      idFactory('web', 'api'),
    );
    await Promise.resolve();

    expect(events).toEqual(['save']);

    pending.resolve();
    await expect(bootstrapping).resolves.toMatchObject({ kind: 'ready' });
    expect(events).toEqual(['save', anchor.rootDirectoryPath, anchor.namespaceDirectoryPath]);
    expect(store.saved()).toEqual([
      mkEntry('web', 'web', '/home/user/web'),
      mkEntry('api', 'api', '/home/user/api'),
    ]);
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
        idFactory('web'),
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
      idFactory('web'),
    );

    expect(result).toEqual({ kind: 'disabled', reason: 'missing-anchor' });
    expect(events).toEqual(['save', anchor.rootDirectoryPath]);
    expect(store.saved()).toEqual([mkEntry('web', 'web', '/home/user/web')]);
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
    const result = await bootstrapWorkspace(
      host,
      fileInfo,
      store.port,
      okDir,
      idFactory('web', 'api'),
    );

    expect(result).toMatchObject({ kind: 'ready' });
    expect(mutationCalls).toBe(0);
  });
});
