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
    ['folder が空', []],
    ['folder が複数', [folder('API', activeLinkUri), folder('Web', 'file:///web' as UriString)]],
    ['URI が不一致', [folder('API', 'file:///projects/api' as UriString)]],
    ['表示名が不一致', [folder('Web', activeLinkUri)]],
  ])('%sなら active link folder 一件へ修復する', async (_case, currentFolders) => {
    const h = createHarness(currentFolders);

    await expect(h.viewRebind.rebindActiveFolder(activeLane)).resolves.toBe(true);

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

  it('folder 構成が一致すれば mutation を省略する', async () => {
    const h = createHarness([folder(activeLane.label, activeLinkUri)]);

    await expect(h.viewRebind.rebindActiveFolder(activeLane)).resolves.toBe(true);

    expect(h.applyMutation).not.toHaveBeenCalled();
    expect(h.rebindGitRepository).toHaveBeenCalledOnce();
  });

  it('workspace mutation の拒否を返して Git 再走査へ進まない', async () => {
    const h = createHarness([folder('Web', activeLinkUri)], false);

    await expect(h.viewRebind.rebindActiveFolder(activeLane)).resolves.toBe(false);

    expect(h.rebindGitRepository).not.toHaveBeenCalled();
  });

  it('workspace mutation の reject を伝播して Git 再走査へ進まない', async () => {
    const failure = new Error('mutation failed');
    const h = createHarness([folder('Web', activeLinkUri)], failure);

    await expect(h.viewRebind.rebindActiveFolder(activeLane)).rejects.toBe(failure);

    expect(h.rebindGitRepository).not.toHaveBeenCalled();
  });

  it('Git 再走査の失敗は workspace mutation の成功を覆さない', async () => {
    const h = createHarness([folder('Web', activeLinkUri)]);
    h.rebindGitRepository.mockRejectedValueOnce(new Error('Git unavailable'));

    await expect(h.viewRebind.rebindActiveFolder(activeLane)).resolves.toBe(true);
  });
});
