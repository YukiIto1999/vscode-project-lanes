import type { AbsolutePath } from '../foundation/model';
import type { FolderMutation, WorkspaceAnchor, WorkspaceFileInfo, WorkspaceFolder } from './model';

/** ワークスペースフォルダ操作ポート */
export interface WorkspaceHostPort {
  readonly readFolders: () => readonly WorkspaceFolder[];
  readonly applyMutation: (mutation: FolderMutation) => void;
}

/** ワークスペースファイル参照ポート */
export interface WorkspaceFilePort {
  readonly read: () => WorkspaceFileInfo | undefined;
}

/** ファイルシステムディレクトリ操作ポート */
export interface DirectoryPort {
  readonly ensureDirectory: (path: AbsolutePath) => boolean;
}

/** レーンカタログ永続化ポート（workspaceState スコープ） */
export interface CatalogStorePort {
  readonly load: () => readonly WorkspaceFolder[] | undefined;
  readonly save: (folders: readonly WorkspaceFolder[]) => void;
}

/** ワークスペース設定ポート */
export interface WorkspaceSettingsPort {
  readonly hideAnchor: (anchor: WorkspaceAnchor) => void;
  readonly setDefaultTerminalProfile: (profileName: string) => void;
  readonly disablePersistentTerminals: () => void;
}
