import { describe, expect, it } from 'vitest';
import type { LaneId, UriString } from '../foundation/model';
import type { LaneCatalog } from '../lane/model';
import type { WorkspaceFolder } from './model';
import type { CatalogStorePort } from './ports';
import { buildCatalog, createCatalogRegistry } from './registry';

const toUri = (path: string) => `file://${path}` as UriString;
const mkFolder = (name: string, path: string): WorkspaceFolder => ({
  name,
  uri: toUri(path),
});

const makeStore = (
  initial: readonly WorkspaceFolder[] | undefined = undefined,
  persist: (folders: readonly WorkspaceFolder[]) => Promise<void> = async () => {},
): CatalogStorePort & { readonly saved: () => readonly WorkspaceFolder[] | undefined } => {
  let stored: readonly WorkspaceFolder[] | undefined = initial;
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
  it('snapshot と folders が初期状態で整合', () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const registry = createCatalogRegistry(initial, makeStore());
    expect(registry.folders()).toEqual(initial);
    expect(registry.snapshot().lanes.map((l) => l.label)).toEqual(['web']);
  });

  it('replace: 変化があれば通知 + 保存、無ければ noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);
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
    const registry = createCatalogRegistry(initial, store);

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
    const registry = createCatalogRegistry(initial, store);
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    await expect(registry.absorb(initial)).resolves.toEqual([]);
    expect(seen).toHaveLength(0);
    expect(store.saved()).toBeUndefined();
  });

  it('onChange: dispose で購読解除', async () => {
    const registry = createCatalogRegistry([mkFolder('web', '/home/user/web')], makeStore());
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
    const registry = createCatalogRegistry(initial, store);
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    await expect(registry.rename('web', 'frontend')).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(registry.folders().map((f) => f.name)).toEqual(['frontend', 'api']);
    expect(store.saved()).toEqual([
      mkFolder('frontend', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
  });

  it('rename: 同名指定は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);
    await expect(registry.rename('web', 'web')).resolves.toBe(false);
    expect(store.saved()).toBeUndefined();
  });

  it('rename: 未知の name は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);
    await expect(registry.rename('missing', 'other')).resolves.toBe(false);
    expect(store.saved()).toBeUndefined();
  });

  it('relocate: name、LaneId、順序を維持して uri だけを書き換える', async () => {
    const initial = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);
    const seen: LaneCatalog[] = [];
    registry.onChange((catalog) => seen.push(catalog));
    const replacementUri = toUri('/moved/web');

    await expect(registry.relocate('web' as LaneId, replacementUri)).resolves.toBe(true);

    const expected = [{ name: 'web', uri: replacementUri }, mkFolder('api', '/home/user/api')];
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
    const registry = createCatalogRegistry(initial, store);

    await expect(registry.relocate('web' as LaneId, initial[0]!.uri)).resolves.toBe(false);

    expect(store.saved()).toBeUndefined();
  });

  it('relocate: 未知の LaneId は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);

    await expect(registry.relocate('missing' as LaneId, toUri('/moved/web'))).resolves.toBe(false);

    expect(store.saved()).toBeUndefined();
  });

  it('relocate: 保存完了前は置換後 snapshot を公開しない', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const pending = deferred();
    const registry = createCatalogRegistry(
      initial,
      makeStore(undefined, () => pending.promise),
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
    const registry = createCatalogRegistry(initial, store);

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
    const registry = createCatalogRegistry(initial, store);
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    await expect(registry.remove('api')).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(registry.folders().map((f) => f.name)).toEqual(['web']);
    expect(store.saved()).toEqual([mkFolder('web', '/home/user/web')]);
  });

  it('remove: 未知の name は noop', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);
    await expect(registry.remove('missing')).resolves.toBe(false);
    expect(store.saved()).toBeUndefined();
  });

  it('保存完了前は状態と listener を更新しない', async () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const pending = deferred();
    const registry = createCatalogRegistry(
      initial,
      makeStore(undefined, () => pending.promise),
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
    );
    const seen: LaneCatalog[] = [];
    registry.onChange((catalog) => seen.push(catalog));

    await expect(registry.remove('web')).rejects.toBe(failure);
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
    const registry = createCatalogRegistry(initial, store);

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
