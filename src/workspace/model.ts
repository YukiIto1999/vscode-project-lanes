import type { AbsolutePath, UriString, WorkspaceKey } from '../foundation/model';
import type { LaneCatalog } from '../lane/model';

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

/** ディレクトリエントリ（スキャン結果） */
export interface DirectoryEntry {
  readonly name: string;
  readonly path: AbsolutePath;
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
  readonly catalog: LaneCatalog;
}

/** ブートストラップ結果 */
export type WorkspaceBootstrapResult =
  | { readonly kind: 'disabled'; readonly reason: 'no-workspace' | 'missing-anchor' }
  | { readonly kind: 'ready'; readonly context: WorkspaceContext };
