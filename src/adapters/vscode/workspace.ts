import * as vscode from 'vscode';
import type { AbsolutePath, UriString } from '../../foundation/model';
import { uriToAbsolutePath } from '../../foundation/path';
import type { FolderMutation, WorkspaceFolder } from '../../workspace/model';
import type {
  DirectoryPort,
  WorkspaceFilePort,
  WorkspaceHostPort,
  WorkspaceSettingsPort,
} from '../../workspace/ports';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * onDidChangeWorkspaceFolders 発火待ちの上限
 * 先頭フォルダの変更では拡張ホストが再起動され発火自体が起きない場合がある(VS Code API 仕様)
 */
const FOLDER_CHANGE_SETTLE_TIMEOUT_MS = 3000;

/**
 * 単一の workspaceFolders 変更適用、発火または上限時間まで待って確定
 * @param mutation - 変更操作
 * @returns 変更が確定すれば true、VS Code に拒否されれば false
 */
const applySingleMutation = (mutation: FolderMutation): Promise<boolean> => {
  if (mutation.deleteCount === 0 && mutation.folders.length === 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      changeListener.dispose();
      resolve(result);
    };

    const changeListener = vscode.workspace.onDidChangeWorkspaceFolders(() => finish(true));
    const timer = setTimeout(() => finish(true), FOLDER_CHANGE_SETTLE_TIMEOUT_MS);

    const accepted = vscode.workspace.updateWorkspaceFolders(
      mutation.start,
      mutation.deleteCount,
      ...mutation.folders.map((f) => ({
        uri: vscode.Uri.parse(f.uri),
        name: f.name,
      })),
    );
    if (!accepted) finish(false);
  });
};

/**
 * VS Code ワークスペースフォルダ操作アダプターの生成
 * updateWorkspaceFolders は発火待ちせず連続呼び出すと後続が黙って拒否される(VS Code API 仕様)ため直列化する
 * @returns workspaceFolders 操作ポート
 */
export const createWorkspaceHostAdapter = (): WorkspaceHostPort => {
  let queue: Promise<unknown> = Promise.resolve();

  return {
    readFolders: (): readonly WorkspaceFolder[] =>
      (vscode.workspace.workspaceFolders ?? []).map((f) => ({
        uri: f.uri.toString() as UriString,
        name: f.name,
      })),

    applyMutation: (mutation) => {
      const result = queue.then(() => applySingleMutation(mutation));
      queue = result;
      return result;
    },
  };
};

/**
 * VS Code ワークスペースファイル参照アダプターの生成
 * @returns ワークスペースファイル参照ポート
 */
export const createWorkspaceFileAdapter = (): WorkspaceFilePort => ({
  read: () => {
    const uri = vscode.workspace.workspaceFile;
    if (!uri || uri.scheme !== 'file') return undefined;
    const uriString = uri.toString() as UriString;
    const filePath = uriToAbsolutePath(uriString);
    return {
      uri: uriString,
      directoryPath: nodePath.dirname(filePath) as AbsolutePath,
    };
  },
});

/**
 * ファイルシステムディレクトリ操作アダプターの生成
 * @returns ディレクトリ操作ポート
 */
export const createDirectoryAdapter = (): DirectoryPort => ({
  ensureDirectory: (path) => {
    try {
      fs.mkdirSync(path, { recursive: true });
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * VS Code ワークスペース設定アダプターの生成
 * @returns ワークスペース設定ポート
 */
export const createWorkspaceSettingsAdapter = (): WorkspaceSettingsPort => ({
  setDefaultTerminalProfile: (profileTitle) => {
    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    const current = cfg.get<string>('defaultProfile.linux');
    if (current !== profileTitle) {
      cfg.update('defaultProfile.linux', profileTitle, vscode.ConfigurationTarget.Workspace);
    }
  },

  disablePersistentTerminals: () => {
    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    const current = cfg.get<boolean>('enablePersistentSessions');
    if (current !== false) {
      cfg.update('enablePersistentSessions', false, vscode.ConfigurationTarget.Workspace);
    }
  },
});
