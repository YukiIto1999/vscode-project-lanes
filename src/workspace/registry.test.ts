import { describe, expect, it } from 'vitest';
import type { UriString } from '../foundation/model';
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
): CatalogStorePort & { readonly saved: () => readonly WorkspaceFolder[] | undefined } => {
  let stored: readonly WorkspaceFolder[] | undefined = initial;
  return {
    load: () => stored,
    save: (folders) => {
      stored = folders;
    },
    saved: () => stored,
  };
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

  it('replace: 変化があれば通知 + 保存、無ければ noop', () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    expect(registry.replace(initial)).toBe(false);
    expect(seen).toHaveLength(0);
    expect(store.saved()).toBeUndefined();

    const next = [mkFolder('web', '/home/user/web'), mkFolder('api', '/home/user/api')];
    expect(registry.replace(next)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(store.saved()).toEqual(next);
    expect(registry.snapshot().lanes).toHaveLength(2);
  });

  it('absorb: 既知は無視、未知のみ追記', () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);

    const added = registry.absorb([
      mkFolder('web', '/home/user/web'),
      mkFolder('api', '/home/user/api'),
    ]);
    expect(added).toEqual(['api']);
    expect(registry.folders().map((f) => f.name)).toEqual(['web', 'api']);
    expect(store.saved()).toHaveLength(2);
  });

  it('absorb: 全て既知なら変更なし', () => {
    const initial = [mkFolder('web', '/home/user/web')];
    const store = makeStore();
    const registry = createCatalogRegistry(initial, store);
    const seen: LaneCatalog[] = [];
    registry.onChange((c) => seen.push(c));

    expect(registry.absorb(initial)).toEqual([]);
    expect(seen).toHaveLength(0);
    expect(store.saved()).toBeUndefined();
  });

  it('onChange: dispose で購読解除', () => {
    const registry = createCatalogRegistry([mkFolder('web', '/home/user/web')], makeStore());
    const seen: LaneCatalog[] = [];
    const sub = registry.onChange((c) => seen.push(c));
    registry.absorb([mkFolder('api', '/home/user/api')]);
    sub.dispose();
    registry.absorb([mkFolder('docs', '/home/user/docs')]);
    expect(seen).toHaveLength(1);
  });
});
