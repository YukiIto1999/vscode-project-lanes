import type { AbsolutePath } from '../foundation/model';
import type { DirectoryEntry, FolderMutation, WorkspaceAnchor, WorkspaceFolder } from './model';

/** ワークスペースフォルダ操作ポート */
export interface WorkspaceHostPort {
  readonly readFolders: () => readonly WorkspaceFolder[];
  readonly applyMutation: (mutation: FolderMutation) => void;
}

/** ファイルシステムディレクトリ操作ポート */
export interface DirectoryPort {
  readonly listDirectories: (parentPath: AbsolutePath) => readonly DirectoryEntry[];
  readonly ensureDirectory: (path: AbsolutePath) => boolean;
}

/** ワークスペース設定ポート */
export interface WorkspaceSettingsPort {
  readonly hideAnchor: (anchor: WorkspaceAnchor) => void;
  readonly setDefaultTerminalProfile: (profileName: string) => void;
}
