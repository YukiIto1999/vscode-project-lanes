import type { AbsolutePath } from '../foundation/model';
import type { FolderMutation, WorkspaceFileInfo, WorkspaceFolder } from './model';

/** ワークスペースフォルダ操作ポート */
export interface WorkspaceHostPort {
  /**
   * 現在のフォルダ列の取得
   * @returns workspaceFolders の現状
   */
  readonly readFolders: () => readonly WorkspaceFolder[];
  /**
   * フォルダ列への変更適用
   * @param mutation - 変更操作
   */
  readonly applyMutation: (mutation: FolderMutation) => void;
}

/** アクティブレーン symlink の操作ポート */
export interface WorkspaceLinkPort {
  /** symlink の絶対パス */
  readonly linkPath: AbsolutePath;
  /**
   * symlink の現参照先取得
   * @returns 現参照先の絶対パス、または未設定なら undefined
   */
  readonly readTarget: () => AbsolutePath | undefined;
  /**
   * symlink の参照先入替
   * @param target - 新しい参照先絶対パス
   */
  readonly swap: (target: AbsolutePath) => void;
}

/** ワークスペースファイル参照ポート */
export interface WorkspaceFilePort {
  /**
   * ワークスペースファイル情報の取得
   * @returns ワークスペースファイル情報、または無効状態で undefined
   */
  readonly read: () => WorkspaceFileInfo | undefined;
}

/** ファイルシステムディレクトリ操作ポート */
export interface DirectoryPort {
  /**
   * ディレクトリの存在確保
   * @param path - 対象絶対パス
   * @returns 存在化に成功すれば true
   */
  readonly ensureDirectory: (path: AbsolutePath) => boolean;
}

/** レーンカタログ永続化ポート */
export interface CatalogStorePort {
  /**
   * カタログの読込
   * @returns 永続化済みのレーン列、または未保存で undefined
   */
  readonly load: () => readonly WorkspaceFolder[] | undefined;
  /**
   * カタログの保存
   * @param folders - 永続化対象のレーン列
   */
  readonly save: (folders: readonly WorkspaceFolder[]) => void;
}

/** ワークスペース設定ポート */
export interface WorkspaceSettingsPort {
  /**
   * 既定ターミナルプロファイル設定
   * @param profileTitle - 対象プロファイルの title
   */
  readonly setDefaultTerminalProfile: (profileTitle: string) => void;
  /** ターミナルセッションの永続化抑止 */
  readonly disablePersistentTerminals: () => void;
}
