import type { AbsolutePath, UriString, WorkspaceKey } from '../foundation/model';

/** ワークスペースフォルダ情報 */
export interface WorkspaceFolder {
  /** フォルダ URI */
  readonly uri: UriString;
  /** 表示名 */
  readonly name: string;
}

/** アンカーディレクトリ情報 */
export interface WorkspaceAnchor {
  /** アンカー名 */
  readonly name: '.lanes-root';
  /** アンカー URI */
  readonly uri: UriString;
  /** アンカー絶対パス */
  readonly path: AbsolutePath;
  /** アンカー親ディレクトリ絶対パス */
  readonly parentPath: AbsolutePath;
}

/** ワークスペースファイル情報 */
export interface WorkspaceFileInfo {
  /** ワークスペースファイル URI */
  readonly uri: UriString;
  /** ワークスペースファイル所在ディレクトリ */
  readonly directoryPath: AbsolutePath;
}

/** ワークスペースフォルダ変更操作 */
export interface FolderMutation {
  /** 操作開始インデックス */
  readonly start: number;
  /** 削除件数 */
  readonly deleteCount: number;
  /** 挿入フォルダ列 */
  readonly folders: readonly WorkspaceFolder[];
}

/** ブートストラップ済みワークスペース情報 */
export interface WorkspaceContext {
  /** ワークスペース永続キー */
  readonly key: WorkspaceKey;
  /** アンカー情報 */
  readonly anchor: WorkspaceAnchor;
  /** レーン正本 */
  readonly canonicalLanes: readonly WorkspaceFolder[];
}

/** ブートストラップ結果 */
export type WorkspaceBootstrapResult =
  | {
      /** 無効化結果 */
      readonly kind: 'disabled';
      /** 無効化理由 */
      readonly reason: 'no-workspace-file' | 'missing-anchor';
    }
  | {
      /** 利用可能結果 */
      readonly kind: 'ready';
      /** ワークスペース情報 */
      readonly context: WorkspaceContext;
    };

/** アクティブレーン symlink の参照状態 */
export interface ActiveLinkState {
  /** symlink 自身の絶対パス */
  readonly linkPath: AbsolutePath;
  /** symlink の現参照先 */
  readonly targetPath: AbsolutePath | undefined;
}

/** アクティブレーン切替の純粋計画 */
export interface ActiveLinkSwapPlan {
  /** symlink 自身の絶対パス */
  readonly linkPath: AbsolutePath;
  /** 切替前の参照先 */
  readonly from: AbsolutePath | undefined;
  /** 切替後の参照先 */
  readonly to: AbsolutePath;
}
