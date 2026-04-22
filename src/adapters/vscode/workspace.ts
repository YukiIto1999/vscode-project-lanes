import * as vscode from 'vscode';
import type { AbsolutePath, UriString } from '../../foundation/model';
import { uriToAbsolutePath } from '../../foundation/path';
import type { WorkspaceFolder } from '../../workspace/model';
import type {
  DirectoryPort,
  WorkspaceFilePort,
  WorkspaceHostPort,
  WorkspaceSettingsPort,
} from '../../workspace/ports';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

/** VS Code ワークスペースフォルダ操作のアダプター */
export const createWorkspaceHostAdapter = (): WorkspaceHostPort => ({
  readFolders: (): readonly WorkspaceFolder[] =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => ({
      uri: f.uri.toString() as UriString,
      name: f.name,
    })),

  applyMutation: (mutation) => {
    vscode.workspace.updateWorkspaceFolders(
      mutation.start,
      mutation.deleteCount,
      ...mutation.folders.map((f) => ({
        uri: vscode.Uri.parse(f.uri),
        name: f.name,
      })),
    );
  },
});

/** VS Code ワークスペースファイル参照アダプター */
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

/** ファイルシステムのディレクトリ操作アダプター */
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

/** VS Code ワークスペース設定のアダプター（既存設定とマージ） */
export const createWorkspaceSettingsAdapter = (): WorkspaceSettingsPort => ({
  hideAnchor: (anchor) => {
    const cfg = vscode.workspace.getConfiguration('files', vscode.Uri.parse(anchor.uri));
    const existing = cfg.get<Record<string, boolean>>('exclude') ?? {};
    if (!existing['**']) {
      cfg.update(
        'exclude',
        { ...existing, '**': true },
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
    }
  },

  setDefaultTerminalProfile: (profileName) => {
    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    const current = cfg.get<string>('defaultProfile.linux');
    if (current !== profileName) {
      cfg.update('defaultProfile.linux', profileName, vscode.ConfigurationTarget.Workspace);
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
