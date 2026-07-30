import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import type { LaneId, UriString, WorkspaceKey } from '../../foundation/model';
import type { CatalogEntry } from '../../workspace/model';
import { createCatalogStoreAdapter, createSelectionStoreAdapter } from './storage';

const folders: readonly CatalogEntry[] = [
  { id: 'web' as LaneId, name: 'web', uri: 'file:///home/user/web' as UriString },
];

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const makeMemento = (update: Memento['update']): Memento => ({
  get: <T>() => undefined as T | undefined,
  update,
  keys: () => [],
});

describe('createSelectionStoreAdapter', () => {
  it('v2 selection を明示的な union として読み込む', () => {
    const memento = makeMemento(async () => {});
    memento.get = <T>() =>
      ({ schemaVersion: 2, laneId: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' }) as T;

    expect(createSelectionStoreAdapter(memento).load('workspace:test' as WorkspaceKey)).toEqual({
      kind: 'v2',
      laneId: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
    });
  });

  it.each(['', 'not-a-canonical-lane-id'])(
    '不正な v2 selection ID %j は cache miss として扱う',
    (laneId) => {
      const memento = makeMemento(async () => {});
      memento.get = <T>() => ({ schemaVersion: 2, laneId }) as T;

      expect(createSelectionStoreAdapter(memento).load('workspace:test' as WorkspaceKey)).toBe(
        undefined,
      );
    },
  );

  it('旧 raw label を legacy selection として読み込む', () => {
    const memento = makeMemento(async () => {});
    memento.get = <T>() => 'web' as T;

    expect(createSelectionStoreAdapter(memento).load('workspace:test' as WorkspaceKey)).toEqual({
      kind: 'legacy',
      label: 'web',
    });
  });

  it('selection を schemaVersion 2 で保存する', async () => {
    const updates: unknown[] = [];
    const store = createSelectionStoreAdapter(
      makeMemento(async (_key, value) => {
        updates.push(value);
      }),
    );

    await store.save(
      'workspace:test' as WorkspaceKey,
      '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' as LaneId,
    );

    expect(updates).toEqual([
      {
        schemaVersion: 2,
        laneId: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
      },
    ]);
  });

  it('workspaceState.update の完了を待つ', async () => {
    const pending = deferred();
    const store = createSelectionStoreAdapter(makeMemento(() => pending.promise));

    let completed = false;
    const saving = store.save('workspace:test' as WorkspaceKey, 'web' as LaneId).then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(completed).toBe(false);

    pending.resolve();
    await saving;
    expect(completed).toBe(true);
  });

  it('workspaceState.update の失敗を caller へ伝える', async () => {
    const failure = new Error('update failed');
    const store = createSelectionStoreAdapter(makeMemento(() => Promise.reject(failure)));

    await expect(store.save('workspace:test' as WorkspaceKey, 'web' as LaneId)).rejects.toBe(
      failure,
    );
  });
});

describe('createCatalogStoreAdapter', () => {
  it('v1 rows を canonical root から安定した SHA-256 ID へ移行する', () => {
    const raw = [
      { uri: 'file:///home/user/web', name: 'web' },
      { uri: 'file:///home/user/api', name: 'api' },
    ];
    const firstMemento = makeMemento(async () => {});
    firstMemento.get = <T>() => raw as T;
    const secondMemento = makeMemento(async () => {});
    secondMemento.get = <T>() => raw as T;

    const first = createCatalogStoreAdapter(firstMemento).load();
    const second = createCatalogStoreAdapter(secondMemento).load();

    expect(first).toEqual(second);
    expect(first?.map((entry) => entry.id)).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(first?.[0]?.id).not.toBe(first?.[1]?.id);
  });

  it('v1 load・v2 save・新しい Memento からの reload で同じ ID を維持する', async () => {
    let persisted: unknown = [{ uri: 'file:///home/user/web', name: 'web' }];
    const firstMemento = makeMemento(async (_key, value) => {
      persisted = value;
    });
    firstMemento.get = <T>() => persisted as T;
    const firstStore = createCatalogStoreAdapter(firstMemento);
    const migrated = firstStore.load();

    expect(migrated).toHaveLength(1);
    await firstStore.save(migrated!);

    const reloadedMemento = makeMemento(async () => {});
    reloadedMemento.get = <T>() => persisted as T;
    expect(createCatalogStoreAdapter(reloadedMemento).load()).toEqual(migrated);
    expect(createCatalogStoreAdapter(reloadedMemento).load()?.[0]?.name).toBe('web');
    expect(persisted).toEqual([
      {
        schemaVersion: 2,
        id: migrated?.[0]?.id,
        uri: 'file:///home/user/web',
        name: 'web',
      },
    ]);
  });

  it('v1 migration は既存 v2 ID を先に予約して衝突を deterministic salt で回避する', () => {
    const legacyOnly = makeMemento(async () => {});
    legacyOnly.get = <T>() => [{ uri: 'file:///home/user/web', name: 'web' }] as T;
    const reservedId = createCatalogStoreAdapter(legacyOnly).load()?.[0]?.id;
    const mixed = makeMemento(async () => {});
    mixed.get = <T>() =>
      [
        {
          schemaVersion: 2,
          id: reservedId,
          uri: 'file:///home/user/api',
          name: 'api',
        },
        { uri: 'file:///home/user/web', name: 'web' },
      ] as T;

    const first = createCatalogStoreAdapter(mixed).load();
    const second = createCatalogStoreAdapter(mixed).load();

    expect(first).toEqual(second);
    expect(first?.[0]?.id).toBe(reservedId);
    expect(first?.[1]?.id).not.toBe(reservedId);
  });

  it('v1 migration ID は URI 表記ではなく canonical root から導出する', () => {
    const encoded = makeMemento(async () => {});
    encoded.get = <T>() => [{ uri: 'file:///home/user/my%20project', name: 'web' }] as T;
    const plain = makeMemento(async () => {});
    plain.get = <T>() => [{ uri: 'file:///home/user/my project', name: 'web' }] as T;

    expect(createCatalogStoreAdapter(encoded).load()?.[0]?.id).toBe(
      createCatalogStoreAdapter(plain).load()?.[0]?.id,
    );
  });

  it.each([
    ['invalid row', [{ schemaVersion: 2, id: '', uri: 'file:///home/user/web', name: 'web' }]],
    [
      'duplicate id',
      [
        {
          schemaVersion: 2,
          id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
          uri: 'file:///home/user/web',
          name: 'web',
        },
        {
          schemaVersion: 2,
          id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
          uri: 'file:///home/user/api',
          name: 'api',
        },
      ],
    ],
    [
      'duplicate root',
      [
        {
          schemaVersion: 2,
          id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
          uri: 'file:///home/user/web',
          name: 'web',
        },
        {
          schemaVersion: 2,
          id: '9b2aa5a7-b9ab-49d9-aa66-86858603d845',
          uri: 'file:///home/user/web',
          name: 'api',
        },
      ],
    ],
    [
      'duplicate v1 root',
      [
        { uri: 'file:///home/user/web', name: 'web' },
        { uri: 'file:///home/user/web', name: 'web-copy' },
      ],
    ],
    [
      'duplicate mixed root',
      [
        {
          schemaVersion: 2,
          id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
          uri: 'file:///home/user/web',
          name: 'web',
        },
        { uri: 'file:///home/user/web', name: 'legacy-web' },
      ],
    ],
    [
      'duplicate mixed URI alias root',
      [
        {
          schemaVersion: 2,
          id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
          uri: 'file:///home/user/my%20project',
          name: 'web',
        },
        { uri: 'file:///home/user/my project', name: 'legacy-web' },
      ],
    ],
    [
      'duplicate mixed trailing separator root',
      [
        {
          schemaVersion: 2,
          id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
          uri: 'file:///home/user/web/',
          name: 'web',
        },
        { uri: 'file:///home/user/web', name: 'legacy-web' },
      ],
    ],
    ['empty v1 name', [{ uri: 'file:///home/user/web', name: '' }]],
  ])('%s の catalog は fail closed', (_case, raw) => {
    const memento = makeMemento(async () => {});
    memento.get = <T>() => raw as T;

    expect(() => createCatalogStoreAdapter(memento).load()).toThrow();
  });

  it('catalog を schemaVersion 2 の正確な row 形状で保存する', async () => {
    const updates: unknown[] = [];
    const store = createCatalogStoreAdapter(
      makeMemento(async (_key, value) => {
        updates.push(value);
      }),
    );

    await store.save([
      {
        id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' as LaneId,
        uri: 'file:///home/user/web' as UriString,
        name: 'web',
      },
    ]);

    expect(updates).toEqual([
      [
        {
          schemaVersion: 2,
          id: '4a79c5d0-2bb0-4d96-8870-98ce67fe9066',
          uri: 'file:///home/user/web',
          name: 'web',
        },
      ],
    ]);
  });

  it('workspaceState.update の完了を待つ', async () => {
    const pending = deferred();
    const store = createCatalogStoreAdapter(makeMemento(() => pending.promise));

    let completed = false;
    const saving = store.save(folders).then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(completed).toBe(false);

    pending.resolve();
    await saving;
    expect(completed).toBe(true);
  });

  it('workspaceState.update の失敗を caller へ伝える', async () => {
    const failure = new Error('update failed');
    const store = createCatalogStoreAdapter(makeMemento(() => Promise.reject(failure)));

    await expect(store.save(folders)).rejects.toBe(failure);
  });
});
