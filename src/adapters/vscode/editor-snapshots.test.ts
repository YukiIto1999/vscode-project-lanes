import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import type { LaneId, UriString } from '../../foundation/model';
import { createEditorSnapshotStoreAdapter } from './editor-snapshots';

const webId = '4a79c5d0-2bb0-4d96-8870-98ce67fe9066' as LaneId;
const apiId = '9b2aa5a7-b9ab-49d9-aa66-86858603d845' as LaneId;
const snapshot = (uri: string, viewColumn = 1) => ({
  tabs: [{ uri: uri as UriString, viewColumn }],
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createMemento = (initial: unknown, update: Memento['update'] = async () => {}): Memento => ({
  get: <T>() => initial as T,
  update,
  keys: () => [],
});

describe('createEditorSnapshotStoreAdapter', () => {
  it('v1 snapshot を同期読込し、外部変更から隔離する', () => {
    const raw = {
      schemaVersion: 1,
      byLaneId: {
        [webId]: snapshot('file:///repo/web/source.ts'),
      },
    };
    const store = createEditorSnapshotStoreAdapter(createMemento(raw));

    const first = store.get(webId);
    expect(first).toBeDefined();
    if (!first) throw new Error('Expected stored editor snapshot.');
    (first.tabs as { uri: UriString; viewColumn: number }[]).push({
      uri: 'file:///mutated.ts' as UriString,
      viewColumn: 2,
    });

    expect(store.get(webId)).toEqual(snapshot('file:///repo/web/source.ts'));
  });

  it('lane ごとの不正値だけを除外し、有効値と空 snapshot を保持する', () => {
    const store = createEditorSnapshotStoreAdapter(
      createMemento({
        schemaVersion: 1,
        byLaneId: {
          [webId]: {
            tabs: [
              { uri: 'file:///repo/web/source.ts', viewColumn: 1 },
              { uri: 'file:///repo/web/source.ts', viewColumn: 1 },
              { uri: 'file:///repo/web/source.ts', viewColumn: 2 },
            ],
          },
          [apiId]: { tabs: [] },
          'not-a-canonical-id': snapshot('file:///ignored.ts'),
          'fcb74ac7-5637-4622-a54f-2bc4b058976a': {
            tabs: [{ uri: 'untitled:invalid', viewColumn: 1 }],
          },
          'adcf7e75-eea5-4301-8b36-7454374322c0': {
            tabs: [{ uri: 'file:///invalid-column.ts', viewColumn: 10 }],
          },
        },
      }),
    );

    expect(store.get(webId)).toEqual({
      tabs: [
        { uri: 'file:///repo/web/source.ts', viewColumn: 1 },
        { uri: 'file:///repo/web/source.ts', viewColumn: 2 },
      ],
    });
    expect(store.get(apiId)).toEqual({ tabs: [] });
    expect(store.get('not-a-canonical-id' as LaneId)).toBeUndefined();
    expect(store.get('fcb74ac7-5637-4622-a54f-2bc4b058976a' as LaneId)).toBeUndefined();
    expect(store.get('adcf7e75-eea5-4301-8b36-7454374322c0' as LaneId)).toBeUndefined();
  });

  it.each([
    ['non-integer', 1.5],
    ['zero', 0],
    ['negative', -1],
    ['too large', 10],
  ])('不正な viewColumn (%s) の lane を除外する', (_label, viewColumn) => {
    const store = createEditorSnapshotStoreAdapter(
      createMemento({
        schemaVersion: 1,
        byLaneId: {
          [webId]: snapshot('file:///repo/web/source.ts', viewColumn),
        },
      }),
    );

    expect(store.get(webId)).toBeUndefined();
  });

  it('save の永続化完了後だけ memory を更新し、保存値を copy する', async () => {
    const pending = deferred();
    let persisted: unknown;
    const store = createEditorSnapshotStoreAdapter(
      createMemento(undefined, async (_key, value) => {
        persisted = value;
        await pending.promise;
      }),
    );
    const source = snapshot('file:///repo/web/source.ts');

    const saving = store.save(webId, source);
    (source.tabs as { uri: UriString; viewColumn: number }[])[0]!.viewColumn = 2;
    await Promise.resolve();

    expect(store.get(webId)).toBeUndefined();
    pending.resolve();
    await saving;
    expect(store.get(webId)).toEqual(snapshot('file:///repo/web/source.ts'));
    expect(persisted).toEqual({
      schemaVersion: 1,
      byLaneId: {
        [webId]: snapshot('file:///repo/web/source.ts'),
      },
    });
  });

  it('失敗した write で memory を変えず、後続 write を直列に継続する', async () => {
    const first = deferred();
    const updateValues: unknown[] = [];
    let updateCount = 0;
    const store = createEditorSnapshotStoreAdapter(
      createMemento(undefined, async (_key, value) => {
        updateValues.push(value);
        updateCount += 1;
        if (updateCount === 1) return first.promise;
      }),
    );
    const failure = new Error('update failed');

    const firstSaving = store.save(webId, snapshot('file:///repo/web/failed.ts'));
    const secondSaving = store.save(apiId, snapshot('file:///repo/api/saved.ts'));
    await Promise.resolve();
    await Promise.resolve();
    expect(updateValues).toHaveLength(1);

    first.reject(failure);
    await expect(firstSaving).rejects.toBe(failure);
    await secondSaving;

    expect(store.get(webId)).toBeUndefined();
    expect(store.get(apiId)).toEqual(snapshot('file:///repo/api/saved.ts'));
    expect(updateValues).toEqual([
      {
        schemaVersion: 1,
        byLaneId: {
          [webId]: snapshot('file:///repo/web/failed.ts'),
        },
      },
      {
        schemaVersion: 1,
        byLaneId: {
          [apiId]: snapshot('file:///repo/api/saved.ts'),
        },
      },
    ]);
  });

  it('並行 save を呼出順に直列化し、先行成功を後続値へ含める', async () => {
    const first = deferred();
    const updateValues: unknown[] = [];
    const store = createEditorSnapshotStoreAdapter(
      createMemento(undefined, async (_key, value) => {
        updateValues.push(value);
        if (updateValues.length === 1) await first.promise;
      }),
    );

    const firstSaving = store.save(webId, snapshot('file:///repo/web/source.ts'));
    const secondSaving = store.save(apiId, snapshot('file:///repo/api/source.ts'));
    await Promise.resolve();
    await Promise.resolve();
    expect(updateValues).toHaveLength(1);

    first.resolve();
    await Promise.all([firstSaving, secondSaving]);

    expect(updateValues[1]).toEqual({
      schemaVersion: 1,
      byLaneId: {
        [webId]: snapshot('file:///repo/web/source.ts'),
        [apiId]: snapshot('file:///repo/api/source.ts'),
      },
    });
  });

  it('remove の永続化完了後だけ対象 lane を memory から除外する', async () => {
    const pending = deferred();
    let persisted: unknown;
    const store = createEditorSnapshotStoreAdapter(
      createMemento(
        {
          schemaVersion: 1,
          byLaneId: {
            [webId]: snapshot('file:///repo/web/source.ts'),
            [apiId]: snapshot('file:///repo/api/source.ts'),
          },
        },
        async (_key, value) => {
          persisted = value;
          await pending.promise;
        },
      ),
    );

    const removing = store.remove(webId);
    await Promise.resolve();
    expect(store.get(webId)).toEqual(snapshot('file:///repo/web/source.ts'));

    pending.resolve();
    await removing;
    expect(store.get(webId)).toBeUndefined();
    expect(store.get(apiId)).toEqual(snapshot('file:///repo/api/source.ts'));
    expect(persisted).toEqual({
      schemaVersion: 1,
      byLaneId: {
        [apiId]: snapshot('file:///repo/api/source.ts'),
      },
    });
  });

  it('次の runtime の prune で catalog にない v1 snapshot を永続値から除外する', async () => {
    let persisted: unknown = {
      schemaVersion: 1,
      byLaneId: {
        [webId]: snapshot('file:///repo/web/source.ts'),
        [apiId]: snapshot('file:///repo/api/orphan.ts'),
      },
    };
    const firstMemento = createMemento(persisted, async (_key, value) => {
      persisted = value;
    });

    await expect(createEditorSnapshotStoreAdapter(firstMemento).prune([webId])).resolves.toBe(
      'pruned',
    );

    const restartedStore = createEditorSnapshotStoreAdapter(createMemento(persisted));
    expect(restartedStore.get(webId)).toEqual(snapshot('file:///repo/web/source.ts'));
    expect(restartedStore.get(apiId)).toBeUndefined();
    expect(persisted).toEqual({
      schemaVersion: 1,
      byLaneId: {
        [webId]: snapshot('file:///repo/web/source.ts'),
      },
    });
  });

  it('prune の永続化完了後だけ orphan を memory から除外する', async () => {
    const pending = deferred();
    const store = createEditorSnapshotStoreAdapter(
      createMemento(
        {
          schemaVersion: 1,
          byLaneId: {
            [webId]: snapshot('file:///repo/web/source.ts'),
            [apiId]: snapshot('file:///repo/api/orphan.ts'),
          },
        },
        () => pending.promise,
      ),
    );

    const pruning = store.prune([webId]);
    await Promise.resolve();
    expect(store.get(apiId)).toEqual(snapshot('file:///repo/api/orphan.ts'));

    pending.resolve();
    await expect(pruning).resolves.toBe('pruned');
    expect(store.get(apiId)).toBeUndefined();
  });

  it('prune の write 失敗時は memory を維持して失敗を返す', async () => {
    const failure = new Error('prune update failed');
    const store = createEditorSnapshotStoreAdapter(
      createMemento(
        {
          schemaVersion: 1,
          byLaneId: {
            [webId]: snapshot('file:///repo/web/source.ts'),
            [apiId]: snapshot('file:///repo/api/orphan.ts'),
          },
        },
        async () => {
          throw failure;
        },
      ),
    );

    await expect(store.prune([webId])).rejects.toBe(failure);
    expect(store.get(apiId)).toEqual(snapshot('file:///repo/api/orphan.ts'));
  });

  it('prune を先行 write の後へ直列化し、最新の成功状態から収束させる', async () => {
    const first = deferred();
    const updateValues: unknown[] = [];
    const store = createEditorSnapshotStoreAdapter(
      createMemento(
        {
          schemaVersion: 1,
          byLaneId: {
            [apiId]: snapshot('file:///repo/api/orphan.ts'),
          },
        },
        async (_key, value) => {
          updateValues.push(value);
          if (updateValues.length === 1) await first.promise;
        },
      ),
    );

    const saving = store.save(webId, snapshot('file:///repo/web/source.ts'));
    const pruning = store.prune([webId]);
    await Promise.resolve();
    await Promise.resolve();
    expect(updateValues).toHaveLength(1);

    first.resolve();
    await expect(Promise.all([saving, pruning])).resolves.toEqual([undefined, 'pruned']);
    expect(updateValues[1]).toEqual({
      schemaVersion: 1,
      byLaneId: {
        [webId]: snapshot('file:///repo/web/source.ts'),
      },
    });
  });

  it('変更対象がなければ prune は永続値を更新しない', async () => {
    let updateCount = 0;
    const store = createEditorSnapshotStoreAdapter(
      createMemento(
        {
          schemaVersion: 1,
          byLaneId: {
            [webId]: snapshot('file:///repo/web/source.ts'),
          },
        },
        async () => {
          updateCount += 1;
        },
      ),
    );

    await expect(store.prune([webId])).resolves.toBe('unchanged');
    expect(updateCount).toBe(0);
  });

  it('future schema を読み込まず、save/remove で上書きせず、prune は activation を阻害しない', async () => {
    let updateCount = 0;
    const store = createEditorSnapshotStoreAdapter(
      createMemento({ schemaVersion: 2, byLaneId: {} }, async () => {
        updateCount += 1;
      }),
    );

    expect(store.get(webId)).toBeUndefined();
    await expect(store.save(webId, snapshot('file:///repo/web/source.ts'))).rejects.toThrow(
      'Unsupported Project Lanes editor snapshot schema version: 2',
    );
    await expect(store.remove(webId)).rejects.toThrow(
      'Unsupported Project Lanes editor snapshot schema version: 2',
    );
    await expect(store.prune([webId])).resolves.toBe('protected');
    expect(updateCount).toBe(0);
  });

  it('save 入力が不正なら永続値を更新しない', async () => {
    let updateCount = 0;
    const store = createEditorSnapshotStoreAdapter(
      createMemento(undefined, async () => {
        updateCount += 1;
      }),
    );

    await expect(store.save(webId, snapshot('untitled:invalid'))).rejects.toThrow(
      'Invalid editor snapshot',
    );
    expect(updateCount).toBe(0);
  });
});
