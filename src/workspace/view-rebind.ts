import type { UriString } from '../foundation/model';
import type { Lane } from '../lane/model';
import type { LaneViewRebindPort } from '../lane/ports';
import type { WorkspaceFolder } from './model';
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
 * 表示名を変えずに参照先だけを替えた folder の経由名
 * @param activeLane - 切替先レーン
 * @returns レーン表示名と必ず異なる一時表示名
 */
const transientFolderName = (activeLane: Lane): string =>
  `${activeLane.label} (${activeLane.rootPath})`;

/**
 * workspace view 再束縛の生成
 * @param deps - 再束縛の依存
 * @returns workspace view 再束縛
 */
export const createWorkspaceViewRebind = (deps: WorkspaceViewRebindDeps): LaneViewRebindPort => ({
  rebindActiveFolder: async (activeLane, targetChanged) => {
    const { activeLinkUri, workspaceHost, rebindGitRepository } = deps;
    const currentFolders = workspaceHost.readFolders();
    const currentFolder = currentFolders[0];
    const boundFolder: WorkspaceFolder = { uri: activeLinkUri, name: activeLane.label };
    const isBound =
      currentFolders.length === 1 &&
      currentFolder?.uri === activeLinkUri &&
      currentFolder.name === activeLane.label;

    if (!isBound) {
      const accepted = await workspaceHost.applyMutation({
        expectedFolders: currentFolders,
        start: 0,
        deleteCount: currentFolders.length,
        folders: [boundFolder],
      });
      if (!accepted) return false;
    } else if (targetChanged) {
      // URI と表示名が不変だと folder 変更通知が起きず Explorer が旧 lane の tree を保持するため一時名を経由
      const transientFolders = [{ uri: activeLinkUri, name: transientFolderName(activeLane) }];
      const renamed = await workspaceHost.applyMutation({
        expectedFolders: currentFolders,
        start: 0,
        deleteCount: currentFolders.length,
        folders: transientFolders,
      });
      if (!renamed) return false;
      const restored = await workspaceHost.applyMutation({
        expectedFolders: transientFolders,
        start: 0,
        deleteCount: transientFolders.length,
        folders: [boundFolder],
      });
      if (!restored) return false;
    }

    try {
      await rebindGitRepository(activeLane);
    } catch {
      return true;
    }
    return true;
  },
});
