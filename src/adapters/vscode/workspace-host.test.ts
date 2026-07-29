import { describe, expect, it, vi } from 'vitest';
import type { UriString } from '../../foundation/model';
import type { FolderMutation, WorkspaceFolder } from '../../workspace/model';
import { createQueuedWorkspaceHost } from './workspace-host';

const folder = (name: string, path = name): WorkspaceFolder => ({
  name,
  uri: `file:///home/user/${path}` as UriString,
});

const mutation = (
  expectedFolders: readonly WorkspaceFolder[],
  name = 'active',
): FolderMutation => ({
  start: 0,
  deleteCount: expectedFolders.length,
  folders: [folder(name)],
  expectedFolders,
});

const deferred = () => {
  let resolve!: (accepted: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('createQueuedWorkspaceHost', () => {
  it.each([
    ['URI', [folder('web', 'renamed')]],
    ['name', [folder('renamed', 'web')]],
    ['順序', [folder('api'), folder('web')]],
  ])('expected と %s が異なれば update を呼ばない', async (_difference, current) => {
    const expected = current.length === 1 ? [folder('web')] : [folder('web'), folder('api')];
    const update = vi.fn<(value: FolderMutation) => Promise<boolean>>(() => Promise.resolve(true));
    const host = createQueuedWorkspaceHost({
      readFolders: () => current,
      update,
    });

    await expect(host.applyMutation(mutation(expected))).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['先頭追加', [folder('new'), folder('web'), folder('api'), folder('docs')]],
    ['中間追加', [folder('web'), folder('new'), folder('api'), folder('docs')]],
    ['末尾追加', [folder('web'), folder('api'), folder('docs'), folder('new')]],
    ['先頭削除', [folder('api'), folder('docs')]],
    ['中間削除', [folder('web'), folder('docs')]],
    ['末尾削除', [folder('web'), folder('api')]],
  ])('%sで expected と異なれば update を呼ばない', async (_difference, current) => {
    const expected = [folder('web'), folder('api'), folder('docs')];
    const update = vi.fn<(value: FolderMutation) => Promise<boolean>>(() => Promise.resolve(true));
    const host = createQueuedWorkspaceHost({
      readFolders: () => current,
      update,
    });

    await expect(host.applyMutation(mutation(expected))).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('queue 投入後、実行前に snapshot が変われば update を呼ばない', async () => {
    const initial = [folder('web')];
    const changed = [...initial, folder('api')];
    let current: readonly WorkspaceFolder[] = initial;
    const pending = deferred();
    const update = vi.fn<(value: FolderMutation) => Promise<boolean>>((value) =>
      value.folders[0]!.name === 'holding' ? pending.promise : Promise.resolve(true),
    );
    const host = createQueuedWorkspaceHost({
      readFolders: () => current,
      update,
    });

    const holding = host.applyMutation(mutation(initial, 'holding'));
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();

    const queued = host.applyMutation(mutation(initial));
    current = changed;
    pending.resolve(true);

    await expect(holding).resolves.toBe(true);
    await expect(queued).resolves.toBe(false);
    expect(update).toHaveBeenCalledOnce();
  });

  it('expected と一致するときだけ update を呼ぶ', async () => {
    const current = [folder('web')];
    const update = vi.fn<(value: FolderMutation) => Promise<boolean>>(() => Promise.resolve(true));
    const host = createQueuedWorkspaceHost({
      readFolders: () => current,
      update,
    });
    const planned = mutation(current);

    await expect(host.applyMutation(planned)).resolves.toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(planned);
  });

  it('update の false を caller へ伝える', async () => {
    const current = [folder('web')];
    const update = vi.fn<(value: FolderMutation) => Promise<boolean>>(() => Promise.resolve(false));
    const host = createQueuedWorkspaceHost({
      readFolders: () => current,
      update,
    });

    await expect(host.applyMutation(mutation(current))).resolves.toBe(false);
    expect(update).toHaveBeenCalledOnce();
  });

  it('update の reject を caller へ伝えた後も後続 mutation を実行する', async () => {
    const current = [folder('web')];
    const failure = new Error('update failed');
    let updateCount = 0;
    const update = vi.fn<(value: FolderMutation) => Promise<boolean>>(() => {
      updateCount += 1;
      return updateCount === 1 ? Promise.reject(failure) : Promise.resolve(true);
    });
    const host = createQueuedWorkspaceHost({
      readFolders: () => current,
      update,
    });

    await expect(host.applyMutation(mutation(current))).rejects.toBe(failure);
    await expect(host.applyMutation(mutation(current))).resolves.toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
