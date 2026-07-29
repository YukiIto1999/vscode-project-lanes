import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import type { UriString } from '../../foundation/model';
import type { WorkspaceFolder } from '../../workspace/model';
import { createCatalogStoreAdapter } from './storage';

const folders: readonly WorkspaceFolder[] = [
  { name: 'web', uri: 'file:///home/user/web' as UriString },
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

describe('createCatalogStoreAdapter', () => {
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
