import * as vscode from 'vscode';
import { uriToAbsolutePath } from '../../foundation/path';
import type { LaneViewRebindPort } from '../../lane/ports';
import type { WorkspaceHostPort } from '../../workspace/ports';

/** Git 拡張のリポジトリ参照（必要部分のみ） */
type GitRepositoryRef = object;

/** Git 拡張 API（必要部分のみ） */
interface GitApiShape {
  readonly repositories: readonly GitRepositoryRef[];
  readonly getRepository: (uri: vscode.Uri) => GitRepositoryRef | null;
}

/** Git 拡張 exports（必要部分のみ） */
interface GitExtensionShape {
  readonly getAPI: (version: 1) => GitApiShape;
}

/**
 * Git 拡張 API の取得（未導入・未活性なら undefined）
 * @returns Git API、または取得不可で undefined
 */
const acquireGitApi = async (): Promise<GitApiShape | undefined> => {
  const ext = vscode.extensions.getExtension<GitExtensionShape>('vscode.git');
  if (!ext) return undefined;
  if (!ext.isActive) {
    try {
      await ext.activate();
    } catch {
      return undefined;
    }
  }
  try {
    return ext.exports.getAPI(1);
  } catch {
    return undefined;
  }
};

/**
 * VS Code ビュー再走査アダプターの生成
 * @param workspaceHost - workspaceFolders 操作ポート
 * @returns ビュー再走査ポート
 */
export const createLaneViewRebindAdapter = (
  workspaceHost: WorkspaceHostPort,
): LaneViewRebindPort => ({
  rebindActiveFolder: async (activeLane) => {
    const folders = workspaceHost.readFolders();
    const head = folders[0];
    if (!head) return;

    if (head.name !== activeLane.label) {
      workspaceHost.applyMutation({
        start: 0,
        deleteCount: 1,
        folders: [{ uri: head.uri, name: activeLane.label }],
      });
    }

    const api = await acquireGitApi();
    if (!api) return;

    const folderUri = vscode.Uri.parse(head.uri);
    if (api.getRepository(folderUri)) {
      try {
        await vscode.commands.executeCommand('git.close', folderUri);
      } catch {
        /* close 失敗時の握潰、後続 openRepository に委任 */
      }
    }

    try {
      await vscode.commands.executeCommand('git.openRepository', uriToAbsolutePath(head.uri));
    } catch {
      /* Git 拡張不調時の握潰 */
    }
  },
});
