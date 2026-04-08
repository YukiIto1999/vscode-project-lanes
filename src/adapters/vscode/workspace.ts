import * as vscode from 'vscode';
import type { AbsolutePath, UriString } from '../../foundation/model';
import type { WorkspaceFolder } from '../../workspace/model';
import type {
  DirectoryPort,
  WorkspaceHostPort,
  WorkspaceSettingsPort,
} from '../../workspace/ports';
import * as fs from 'node:fs';

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

/** ファイルシステムのディレクトリ操作アダプター */
export const createDirectoryAdapter = (): DirectoryPort => ({
  listDirectories: (parentPath) => {
    try {
      return fs
        .readdirSync(parentPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => ({
          name: d.name,
          path: `${parentPath}/${d.name}` as AbsolutePath,
        }));
    } catch {
      return [];
    }
  },

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
});
