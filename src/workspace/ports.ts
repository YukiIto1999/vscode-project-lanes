import type { AbsolutePath, LaneId } from '../foundation/model';
import type { LaneRootAvailability } from '../lane/model';
import type { CatalogEntry, FolderMutation, WorkspaceFileInfo, WorkspaceFolder } from './model';

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
   * @returns 変更が確定すれば true、期待状態との不一致または VS Code の拒否で false
   */
  readonly applyMutation: (mutation: FolderMutation) => Promise<boolean>;
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
  /** symlink の削除。未作成は成功、非 symlink または削除失敗では例外 */
  readonly clear: () => void;
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

/** レーンルート利用可否の検査ポート */
export interface LaneRootAvailabilityPort {
  /**
   * レーンルートの現在状態を検査
   * @param path - 対象絶対パス
   * @returns filesystem 由来の利用可否
   */
  readonly inspect: (path: AbsolutePath) => LaneRootAvailability;
}

/** レーンカタログ永続化ポート */
export interface CatalogStorePort {
  /**
   * カタログの読込
   * @returns 永続化済みのレーン列、または未保存で undefined
   */
  readonly load: () => readonly CatalogEntry[] | undefined;
  /**
   * カタログの保存
   * @param folders - 永続化対象のレーン列
   */
  readonly save: (folders: readonly CatalogEntry[]) => Promise<void>;
}

/** 新規レーンの不透明識別子採番ポート */
export interface LaneIdFactoryPort {
  /**
   * 新しい識別子の取得
   * @returns 他のレーンと重複しない LaneId
   */
  readonly next: () => LaneId;
}

/** ワークスペース設定ポート */
export interface WorkspaceSettingsPort {
  /**
   * 既定ターミナルプロファイル設定
   * @param profileTitle - 対象プロファイルの title
   */
  readonly setDefaultTerminalProfile: (profileTitle: string) => Promise<void>;
  /** ターミナルセッションの永続化抑止 */
  readonly disablePersistentTerminals: () => Promise<void>;
}
