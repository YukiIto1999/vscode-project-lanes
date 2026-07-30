import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';

/** ワークスペースフォルダ情報 */
export interface WorkspaceFolder {
  /** フォルダ URI */
  readonly uri: UriString;
  /** 表示名 */
  readonly name: string;
}

/** workspaceState を正本とするレーンカタログ行 */
export interface CatalogEntry extends WorkspaceFolder {
  /** 表示名や所在変更では変わらない不透明識別子 */
  readonly id: LaneId;
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
  /** 変更計画時の workspaceFolders */
  readonly expectedFolders: readonly WorkspaceFolder[];
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
  /** レーン正本 */
  readonly canonicalLanes: readonly CatalogEntry[];
}

/** ワークスペース無効化の理由 */
export type WorkspaceDisabledReason =
  | 'no-workspace-file'
  | 'missing-lane-source'
  | 'missing-anchor'
  | 'workspace-folder-mutation-rejected';

/** ブートストラップ結果 */
export type WorkspaceBootstrapResult =
  | {
      /** 無効化結果 */
      readonly kind: 'disabled';
      /** 無効化理由 */
      readonly reason: WorkspaceDisabledReason;
    }
  | {
      /** 利用可能結果 */
      readonly kind: 'ready';
      /** ワークスペース情報 */
      readonly context: WorkspaceContext;
    };

/** アクティブレーン切替の純粋計画 */
export interface ActiveLinkSwapPlan {
  /** symlink 自身の絶対パス */
  readonly linkPath: AbsolutePath;
  /** 切替前の参照先 */
  readonly from: AbsolutePath | undefined;
  /** 切替後の参照先 */
  readonly to: AbsolutePath;
}
