import type { AbsolutePath, UriString, WorkspaceKey } from '../foundation/model';

/** ワークスペースフォルダ情報 */
export interface WorkspaceFolder {
  readonly uri: UriString;
  readonly name: string;
}

/** .lanes-root アンカーフォルダ */
export interface WorkspaceAnchor {
  readonly name: '.lanes-root';
  readonly uri: UriString;
  readonly path: AbsolutePath;
  readonly parentPath: AbsolutePath;
}

/** ワークスペースファイル情報（.code-workspace） */
export interface WorkspaceFileInfo {
  readonly uri: UriString;
  readonly directoryPath: AbsolutePath;
}

/** ワークスペースフォルダ変更操作 */
export interface FolderMutation {
  readonly start: number;
  readonly deleteCount: number;
  readonly folders: readonly WorkspaceFolder[];
}

/** ブートストラップ済みワークスペース情報 */
export interface WorkspaceContext {
  readonly key: WorkspaceKey;
  readonly anchor: WorkspaceAnchor;
  readonly canonicalLanes: readonly WorkspaceFolder[];
}

/** ブートストラップ結果 */
export type WorkspaceBootstrapResult =
  | {
      readonly kind: 'disabled';
      readonly reason: 'no-workspace-file' | 'missing-anchor';
    }
  | { readonly kind: 'ready'; readonly context: WorkspaceContext };
