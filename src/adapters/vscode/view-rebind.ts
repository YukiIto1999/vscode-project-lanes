import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { AbsolutePath } from '../../foundation/model';
import { uriToAbsolutePath } from '../../foundation/path';
import type { LaneViewRebindPort } from '../../lane/ports';
import type { WorkspaceHostPort } from '../../workspace/ports';

/** Git 拡張 API のうち本拡張が依存する最小契約 */
interface GitApiShape {
  readonly getRepository: (uri: vscode.Uri) => object | null;
}

/** Git 拡張 exports のうち本拡張が依存する最小契約 */
interface GitExtensionShape {
  readonly getAPI: (version: 1) => GitApiShape;
}

/**
 * Git 拡張 API の取得
 * @returns Git API、未導入や未活性で取得不可なら undefined
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
 * レーンルートが git 作業ツリーかの判定
 * @param rootPath - レーンルート絶対パス
 * @returns git リポジトリなら true
 */
const isGitWorktree = (rootPath: AbsolutePath): boolean =>
  fs.existsSync(nodePath.join(rootPath, '.git'));

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

    // git.close による closedRepositories への永続登録回避
    if (!isGitWorktree(activeLane.rootPath)) return;

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
