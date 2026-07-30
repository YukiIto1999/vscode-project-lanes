import { describe, expect, it } from 'vitest';
import type { LaneId, UriString } from '../foundation/model';
import type { LaneCatalog } from '../lane/model';
import type { CatalogEntry } from './model';
import type { CatalogStorePort } from './ports';
import { buildCatalog, createCatalogRegistry } from './registry';

const toUri = (path: string) => `file://${path}` as UriString;
const mkFolder = (name: string, path: string): CatalogEntry => ({
  id: name as LaneId,
  name,
  uri: toUri(path),
});
const mkEntry = (id: string, name: string, path: string) => ({
  id: id as LaneId,
  name,
  uri: toUri(path),
});
const idFactory = (...ids: readonly string[]) => {
  let index = 0;
  return {
    next: () => {
      const id = ids[index];
      if (id === undefined) {
        index += 1;
        return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` as LaneId;
      }
      index += 1;
      return id as LaneId;
    },
  };
};

const makeStore = (
  initial: readonly CatalogEntry[] | undefined = undefined,
  persist: (folders: readonly CatalogEntry[]) => Promise<void> = async () => {},
): CatalogStorePort & { readonly saved: () => readonly CatalogEntry[] | undefined } => {
  let stored: readonly CatalogEntry[] | undefined = initial;
  return {
    load: () => stored,
    save: async (folders) => {
      await persist(folders);
      stored = folders;
    },
    saved: () => stored,
  };
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('buildCatalog', () => {
  it('永続化された opaque ID を label から再生成せず保持する', () => {
    const catalog = buildCatalog([
      mkEntry('4a79c5d0-2bb0-4d96-8870-98ce67fe9066', 'web', '/home/user/web'),
    ]);

    expect(catalog.lanes[0]).toMatchObject({
      id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
      label: 'web',
    });
  });

  it('workspace folders からレーン構築', () => {
    const catalog = buildCatalog([
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
    expect(catalog.lanes).toHaveLength(2);
    expect(catalog.lanes[0]!.label).toBe('web');
    expect(catalog.lanes[0]!.rootPath).toBe('/home/user/web');
    expect(catalog.byId.get('web' as never)?.rootUri).toBe(toUri('/home/user/web'));
  });
});

describe('createCatalogRegistry', () => {
  it('rename は LaneId で対象を特定し、同名 label を許可して ID を維持する', async () => {
    const webId = '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' as LaneId;
    const apiId = '9b2aa5a7-b9ab-49d9-aa66-86858603d845' as LaneId;
    const initial = [
      mkEntry(webId, 'web', '/home/user/web'),
      mkEntry(apiId, 'api', '/home/user/api'),
    ];
    const store = makeStore(initial);
    const registry = createCatalogRegistry(initial, store, idFactory());

    await expect(registry.rename(webId, 'api')).resolves.toBe(true);

    expect(registry.snapshot().lanes).toEqual([
      expect.objectContaining({ id: webId, label: 'api', rootPath: '/home/user/web' }),
      expect.objectContaining({ id: apiId, label: 'api', rootPath: '/home/user/api' }),
    ]);
    expect(registry.folders()).toEqual([
      mkEntry(webId, 'api', '/home/user/web'),
      mkEntry(apiId, 'api', '/home/user/api'),
    ]);
  });

  it('absorb は URI で既知 root を除外し、新規 root にだけ factory ID を割り当てる', async () => {
    const webId = '4a79c5d0-2bb0-4d96-8870-98ce67fe9066';
    const apiId = '9b2aa5a7-b9ab-49d9-aa66-86858603d845';
    const initial = [mkEntry(webId, 'same', '/home/user/web')];
    const registry = createCatalogRegistry(initial, makeStore(initial), idFactory(apiId));

    await expect(
      registry.absorb([
        mkFolder('renamed-host-folder', '/home/user/web'),
        mkFolder('same', '/home/user/api'),
      ]),
    ).resolves.toEqual(['same']);

    expect(registry.folders()).toEqual([
      mkEntry(webId, 'same', '/home/user/web'),
      mkEntry(apiId, 'same', '/home/user/api'),
    ]);
  });

  it('absorb は factory の非 canonical ID を保存前に拒否する', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, {
      next: () => 'not-an-opaque-id' as LaneId,
    });

    await expect(registry.absorb([mkFolder('api', '/home/user/api')])).rejects.toThrow(
      /invalid LaneId/i,
    );
    expect(store.saved()).toBeUndefined();
  });

  it('absorb は URI alias を既知 root として扱い採番も保存もしない', async () => {
    const initial = [mkEntry('web', 'web', '/home/user/my%20project')];
    let allocations = 0;
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, {
      next: () => {
        allocations += 1;
        return '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' as LaneId;
      },
    });

    await expect(registry.absorb([mkFolder('alias', '/home/user/my project')])).resolves.toEqual(
      [],
    );
    expect(allocations).toBe(0);
    expect(store.saved()).toBeUndefined();
  });

  it('absorb は末尾 separator alias も既知 root として扱う', async () => {
    const initial = [mkEntry('web', 'web', '/home/user/web/')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, {
      next: () => {
        throw new Error('must not allocate');
      },
    });

    await expect(registry.absorb([mkFolder('alias', '/home/user/web')])).resolves.toEqual([]);
    expect(store.saved()).toBeUndefined();
  });

  it('relocate は別 lane の既存 root への変更を拒否する', async () => {
    const webId = '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' as LaneId;
    const apiId = '9b2aa5a7-b9ab-49d9-aa66-86858603d845' as LaneId;
    const initial = [
      mkEntry(webId, 'web', '/home/user/web'),
      mkEntry(apiId, 'api', '/home/user/api'),
    ];
    const store = makeStore(initial);
    const registry = createCatalogRegistry(initial, store, idFactory());

    await expect(registry.relocate(webId, toUri('/home/user/api'))).resolves.toBe(false);
    expect(registry.folders()).toEqual(initial);
  });

  it('relocate は別 lane の URI alias root への変更を拒否する', async () => {
    const webId = '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' as LaneId;
    const apiId = '9b2aa5a7-b9ab-49d9-aa66-86858603d845' as LaneId;
    const initial = [
      mkEntry(webId, 'web', '/home/user/my%20project'),
      mkEntry(apiId, 'api', '/home/user/api'),
    ];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());

    await expect(registry.relocate(apiId, toUri('/home/user/my project'))).resolves.toBe(false);
    expect(store.saved()).toBeUndefined();
  });

  it('relocate は別 lane の末尾 separator alias root への変更を拒否する', async () => {
    const webId = '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' as LaneId;
    const apiId = '9b2aa5a7-b9ab-49d9-aa66-86858603d845' as LaneId;
    const initial = [
      mkEntry(webId, 'web', '/home/user/web/'),
      mkEntry(apiId, 'api', '/home/user/api'),
    ];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());

    await expect(registry.relocate(apiId, toUri('/home/user/web'))).resolves.toBe(false);
    expect(store.saved()).toBeUndefined();
  });

  it('snapshot と folders が初期状態で整合', () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const registry = createCatalogRegistry(initial, makeStore(), idFactory());
    expect(registry.folders()).toEqual(initial);
    expect(registry.snapshot().lanes.map((l) => l.label)).toEqual(['web']);
  });

  it('replace: 変化があれば通知 + 保存、無ければ noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    await expect(registry.replace(initial)).resolves.toBe(false);
    expect(seen).toHaveLength(0);
    expect(store.saved()).toBeUndefined();

    const next = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    await expect(registry.replace(next)).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(store.saved()).toEqual(next);
    expect(registry.snapshot().lanes).toHaveLength(2);
  });

  it('absorb: 既知は無視、未知のみ追記', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());

    const added = await registry.absorb([
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
    expect(added).toEqual(['api']);
    expect(registry.folders().map((f) => f.name)).toEqual(['web', 'api']);
    expect(store.saved()).toHaveLength(2);
  });

  it('absorb: 全て既知なら変更なし', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    await expect(registry.absorb(initial)).resolves.toEqual([]);
    expect(seen).toHaveLength(0);
    expect(store.saved()).toBeUndefined();
  });

  it('onChange: dispose で購読解除', async () => {
    const registry = createCatalogRegistry(
      [mkFolder('web', '/home/user/web')],
      makeStore(),
      idFactory(),
    );
    const seen: LaneCatalog[] = [];
    const sub = registry.onChange((c) => seen.push(c));
    await registry.absorb([mkFolder('api', '/home/user/api')]);
    sub.dispose();
    await registry.absorb([mkFolder('docs', '/home/user/docs')]);
    expect(seen).toHaveLength(1);
  });

  it('rename: 既存レーンの name を書き換えて通知 + 保存', async () => {
    const initial = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    await expect(registry.rename('web' as LaneId, 'frontend')).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(registry.folders().map((f) => f.name)).toEqual(['frontend', 'api']);
    expect(store.saved()).toEqual([
      mkEntry('web', 'frontend', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
  });

  it('rename: 同名指定は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());
    await expect(registry.rename('web' as LaneId, 'web')).resolves.toBe(false);
    expect(store.saved()).toBeUndefined();
  });

  it('rename: 未知の name は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());
    await expect(registry.rename('missing' as LaneId, 'other')).resolves.toBe(false);
    expect(store.saved()).toBeUndefined();
  });

  it('relocate: name、LaneId、順序を維持して uri だけを書き換える', async () => {
    const initial = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());
    const seen: LaneCatalog[] = [];
    registry.onChange((catalog) => seen.push(catalog));
    const replacementUri = toUri('/moved/web');

    await expect(registry.relocate('web' as LaneId, replacementUri)).resolves.toBe(true);

    const expected = [
      { id: 'web' as LaneId, name: 'web', uri: replacementUri },
      mkFolder('api', '/home/user/api'),
    ];
    expect(registry.folders()).toEqual(expected);
    expect(registry.snapshot().lanes.map((lane) => lane.id)).toEqual(['web', 'api']);
    expect(registry.snapshot().lanes.map((lane) => lane.rootUri)).toEqual([
      replacementUri,
      toUri('/home/user/api'),
    ]);
    expect(store.saved()).toEqual(expected);
    expect(seen).toHaveLength(1);
  });

  it('relocate: 同じ uri は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());

    await expect(registry.relocate('web' as LaneId, initial[0]!.uri)).resolves.toBe(false);

    expect(store.saved()).toBeUndefined();
  });

  it('relocate: 未知の LaneId は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());

    await expect(registry.relocate('missing' as LaneId, toUri('/moved/web'))).resolves.toBe(false);

    expect(store.saved()).toBeUndefined();
  });

  it('relocate: 保存完了前は置換後 snapshot を公開しない', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const pending = deferred();
    const registry = createCatalogRegistry(
      initial,
      makeStore(undefined, () => pending.promise),
      idFactory(),
    );
    const seen: LaneCatalog[] = [];
    registry.onChange((catalog) => seen.push(catalog));

    const relocating = registry.relocate('web' as LaneId, toUri('/moved/web'));
    await Promise.resolve();

    expect(registry.folders()).toEqual(initial);
    expect(registry.snapshot().lanes[0]!.rootPath).toBe('/home/user/web');
    expect(seen).toHaveLength(0);

    pending.resolve();
    await expect(relocating).resolves.toBe(true);
    expect(registry.snapshot().lanes[0]!.rootPath).toBe('/moved/web');
    expect(seen).toHaveLength(1);
  });

  it('relocate: 保存失敗時は置換後 snapshot を公開しない', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const failure = new Error('save failed');
    const registry = createCatalogRegistry(
      initial,
      makeStore(undefined, () => Promise.reject(failure)),
      idFactory(),
    );
    const seen: LaneCatalog[] = [];
    registry.onChange((catalog) => seen.push(catalog));

    await expect(registry.relocate('web' as LaneId, toUri('/moved/web'))).rejects.toBe(failure);

    expect(registry.folders()).toEqual(initial);
    expect(registry.snapshot().lanes[0]!.rootPath).toBe('/home/user/web');
    expect(seen).toHaveLength(0);
  });

  it('concurrent relocate を直列保存し、後続は最新 uri を置換する', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const firstSave = deferred();
    const savedUris: UriString[] = [];
    const store = makeStore(undefined, async (folders) => {
      savedUris.push(folders[0]!.uri);
      if (savedUris.length === 1) await firstSave.promise;
    });
    const registry = createCatalogRegistry(initial, store, idFactory());

    const first = registry.relocate('web' as LaneId, toUri('/moved/web-1'));
    const second = registry.relocate('web' as LaneId, toUri('/moved/web-2'));
    await Promise.resolve();

    expect(savedUris).toEqual([toUri('/moved/web-1')]);

    firstSave.resolve();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(savedUris).toEqual([toUri('/moved/web-1'), toUri('/moved/web-2')]);
    expect(registry.snapshot().lanes[0]!.rootPath).toBe('/moved/web-2');
  });

  it('remove: 既存レーンを除外して通知 + 保存', async () => {
    const initial = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    await expect(registry.remove('api' as LaneId)).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(registry.folders().map((f) => f.name)).toEqual(['web']);
    expect(store.saved()).toEqual([mkFolder('web', '/home/user/web')]);
  });

  it('remove: 未知の name は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store, idFactory());
    await expect(registry.remove('missing' as LaneId)).resolves.toBe(false);
    expect(store.saved()).toBeUndefined();
  });

  it('保存完了前は状態と listener を更新しない', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const pending = deferred();
    const registry = createCatalogRegistry(
      initial,
      makeStore(undefined, () => pending.promise),
      idFactory(),
    );
    const seen: LaneCatalog[] = [];
    registry.onChange((catalog) => seen.push(catalog));
    const next = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];

    const replacing = registry.replace(next);
    await Promise.resolve();

    expect(registry.folders()).toEqual(initial);
    expect(registry.snapshot().lanes.map((lane) => lane.label)).toEqual(['web']);
    expect(seen).toHaveLength(0);

    pending.resolve();
    await expect(replacing).resolves.toBe(true);
    expect(registry.folders()).toEqual(next);
    expect(seen).toHaveLength(1);
  });

  it('保存失敗を caller へ伝え、状態と listener を更新しない', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const failure = new Error('save failed');
    const registry = createCatalogRegistry(
      initial,
      makeStore(undefined, () => Promise.reject(failure)),
      idFactory(),
    );
    const seen: LaneCatalog[] = [];
    registry.onChange((catalog) => seen.push(catalog));

    await expect(registry.remove('web' as LaneId)).rejects.toBe(failure);
    expect(registry.folders()).toEqual(initial);
    expect(registry.snapshot().lanes.map((lane) => lane.label)).toEqual(['web']);
    expect(seen).toHaveLength(0);
  });

  it('concurrent absorb を直列保存し、最新 folders へ両方を追加', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const firstSave = deferred();
    const secondSave = deferred();
    const savedNames: string[][] = [];
    let activeSaves = 0;
    let maxActiveSaves = 0;
    const store = makeStore(undefined, async (folders) => {
      savedNames.push(folders.map((folder) => folder.name));
      activeSaves += 1;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      await (savedNames.length === 1 ? firstSave.promise : secondSave.promise);
      activeSaves -= 1;
    });
    const registry = createCatalogRegistry(initial, store, idFactory());

    const addingApi = registry.absorb([mkFolder('api', '/home/user/api')]);
    const addingDocs = registry.absorb([mkFolder('docs', '/home/user/docs')]);
    await Promise.resolve();

    expect(savedNames).toEqual([['web', 'api']]);
    expect(maxActiveSaves).toBe(1);

    firstSave.resolve();
    await expect(addingApi).resolves.toEqual(['api']);
    await Promise.resolve();
    expect(savedNames).toEqual([
      ['web', 'api'],
      ['web', 'api', 'docs'],
    ]);

    secondSave.resolve();
    await expect(addingDocs).resolves.toEqual(['docs']);
    expect(registry.folders().map((folder) => folder.name)).toEqual(['web', 'api', 'docs']);
    expect(maxActiveSaves).toBe(1);
  });

  it('concurrent same replace の後続を queue 内で noop にする', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const pending = deferred();
    let saveCount = 0;
    const registry = createCatalogRegistry(
      initial,
      makeStore(undefined, async () => {
        saveCount += 1;
        await pending.promise;
      }),
      idFactory(),
    );
    const seen: LaneCatalog[] = [];
    registry.onChange((catalog) => seen.push(catalog));
    const next = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];

    const first = registry.replace(next);
    const second = registry.replace(next);
    await Promise.resolve();
    expect(saveCount).toBe(1);

    pending.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(saveCount).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('先行 save reject 後も後続 mutation を実行', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const failure = new Error('save failed');
    const firstSave = deferred();
    let saveCount = 0;
    const registry = createCatalogRegistry(
      initial,
      makeStore(undefined, async () => {
        saveCount += 1;
        if (saveCount === 1) await firstSave.promise;
      }),
      idFactory(),
    );

    const addingApi = registry.absorb([mkFolder('api', '/home/user/api')]);
    const addingDocs = registry.absorb([mkFolder('docs', '/home/user/docs')]);
    const firstFailure = addingApi.then(
      () => undefined,
      (error: unknown) => error,
    );

    await Promise.resolve();
    expect(saveCount).toBe(1);

    firstSave.reject(failure);
    await expect(firstFailure).resolves.toBe(failure);
    await expect(addingDocs).resolves.toEqual(['docs']);
    expect(registry.folders().map((folder) => folder.name)).toEqual(['web', 'docs']);
    expect(saveCount).toBe(2);
  });
});
