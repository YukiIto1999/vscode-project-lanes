import { describe, expect, it, vi } from 'vitest';
import type { Lane } from '../lane/model';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { WorkspaceFolder } from './model';
import type { WorkspaceHostPort } from './ports';
import { createWorkspaceViewRebind } from './view-rebind';

const activeLinkUri = 'file:///workspace/.lanes-root/active' as UriString;
const activeLane: Lane = {
  id: 'api' as LaneId,
  label: 'API',
  rootUri: 'file:///projects/api' as UriString,
  rootPath: '/projects/api' as AbsolutePath,
};
const folder = (name: string, uri: UriString): WorkspaceFolder => ({ name, uri });

const createHarness = (
  currentFolders: readonly WorkspaceFolder[],
  accepted: boolean | Error = true,
) => {
  const applyMutation = vi.fn<WorkspaceHostPort['applyMutation']>(() =>
    accepted instanceof Error ? Promise.reject(accepted) : Promise.resolve(accepted),
  );
  const rebindGitRepository = vi.fn<(lane: Lane) => Promise<void>>(() => Promise.resolve());
  const viewRebind = createWorkspaceViewRebind({
    activeLinkUri,
    workspaceHost: {
      readFolders: () => currentFolders,
      applyMutation,
    },
    rebindGitRepository,
  });
  return { applyMutation, rebindGitRepository, viewRebind };
};

describe('createWorkspaceViewRebind', () => {
  it.each([
    ['folder が空', [], false],
    [
      'folder が複数',
      [folder('API', activeLinkUri), folder('Web', 'file:///web' as UriString)],
      false,
    ],
    ['URI が不一致', [folder('API', 'file:///projects/api' as UriString)], false],
    ['表示名が不一致', [folder('Web', activeLinkUri)], false],
    ['参照先変更時に表示名が不一致', [folder('Web', activeLinkUri)], true],
  ])('%sなら active link folder 一件へ修復する', async (_case, currentFolders, targetChanged) => {
    const h = createHarness(currentFolders);

    await expect(h.viewRebind.rebindActiveFolder(activeLane, targetChanged)).resolves.toBe(true);

    expect(h.applyMutation).toHaveBeenCalledOnce();
    expect(h.applyMutation).toHaveBeenCalledWith({
      expectedFolders: currentFolders,
      start: 0,
      deleteCount: currentFolders.length,
      folders: [{ uri: activeLinkUri, name: activeLane.label }],
    });
    expect(h.rebindGitRepository).toHaveBeenCalledOnce();
    expect(h.rebindGitRepository).toHaveBeenCalledWith(activeLane);
  });

  it('参照先が不変で folder 構成が一致すれば mutation を省略する', async () => {
    const h = createHarness([folder(activeLane.label, activeLinkUri)]);

    await expect(h.viewRebind.rebindActiveFolder(activeLane, false)).resolves.toBe(true);

    expect(h.applyMutation).not.toHaveBeenCalled();
    expect(h.rebindGitRepository).toHaveBeenCalledOnce();
  });

  it('参照先が変わり folder 構成が一致すれば一時名を経由して folder 変更を発生させる', async () => {
    const boundFolders = [folder(activeLane.label, activeLinkUri)];
    const transientFolders = [folder('API (/projects/api)', activeLinkUri)];
    const h = createHarness(boundFolders);

    await expect(h.viewRebind.rebindActiveFolder(activeLane, true)).resolves.toBe(true);

    expect(h.applyMutation.mock.calls).toEqual([
      [{ expectedFolders: boundFolders, start: 0, deleteCount: 1, folders: transientFolders }],
      [{ expectedFolders: transientFolders, start: 0, deleteCount: 1, folders: boundFolders }],
    ]);
    expect(h.rebindGitRepository).toHaveBeenCalledOnce();
  });

  it.each([
    ['一時名への変更', [false]],
    ['表示名の復元', [true, false]],
  ])('%sの拒否を返して Git 再走査へ進まない', async (_case, results) => {
    const h = createHarness([folder(activeLane.label, activeLinkUri)]);
    for (const result of results) h.applyMutation.mockResolvedValueOnce(result);

    await expect(h.viewRebind.rebindActiveFolder(activeLane, true)).resolves.toBe(false);

    expect(h.applyMutation).toHaveBeenCalledTimes(results.length);
    expect(h.rebindGitRepository).not.toHaveBeenCalled();
  });

  it('workspace mutation の拒否を返して Git 再走査へ進まない', async () => {
    const h = createHarness([folder('Web', activeLinkUri)], false);

    await expect(h.viewRebind.rebindActiveFolder(activeLane, false)).resolves.toBe(false);

    expect(h.rebindGitRepository).not.toHaveBeenCalled();
  });

  it('workspace mutation の reject を伝播して Git 再走査へ進まない', async () => {
    const failure = new Error('mutation failed');
    const h = createHarness([folder('Web', activeLinkUri)], failure);

    await expect(h.viewRebind.rebindActiveFolder(activeLane, false)).rejects.toBe(failure);

    expect(h.rebindGitRepository).not.toHaveBeenCalled();
  });

  it('Git 再走査の失敗は workspace mutation の成功を覆さない', async () => {
    const h = createHarness([folder('Web', activeLinkUri)]);
    h.rebindGitRepository.mockRejectedValueOnce(new Error('Git unavailable'));

    await expect(h.viewRebind.rebindActiveFolder(activeLane, false)).resolves.toBe(true);
  });
});
