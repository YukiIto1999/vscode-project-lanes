import type { UriString } from '../foundation/model';
import type { Lane } from '../lane/model';
import type { LaneViewRebindPort } from '../lane/ports';
import type { WorkspaceHostPort } from './ports';

/** workspace view 再束縛の依存 */
export interface WorkspaceViewRebindDeps {
  /** active link URI */
  readonly activeLinkUri: UriString;
  /** workspace folder 操作 */
  readonly workspaceHost: WorkspaceHostPort;
  /** Git repository 再束縛 */
  readonly rebindGitRepository: (activeLane: Lane) => Promise<void>;
}

/**
 * workspace view 再束縛の生成
 * @param deps - 再束縛の依存
 * @returns workspace view 再束縛
 */
export const createWorkspaceViewRebind = (deps: WorkspaceViewRebindDeps): LaneViewRebindPort => ({
  rebindActiveFolder: async (activeLane) => {
    const { activeLinkUri, workspaceHost, rebindGitRepository } = deps;
    const currentFolders = workspaceHost.readFolders();
    const currentFolder = currentFolders[0];
    const isBound =
      currentFolders.length === 1 &&
      currentFolder?.uri === activeLinkUri &&
      currentFolder.name === activeLane.label;

    if (!isBound) {
      const accepted = await workspaceHost.applyMutation({
        expectedFolders: currentFolders,
        start: 0,
        deleteCount: currentFolders.length,
        folders: [{ uri: activeLinkUri, name: activeLane.label }],
      });
      if (!accepted) return false;
    }

    try {
      await rebindGitRepository(activeLane);
    } catch {
      return true;
    }
    return true;
  },
});
