import type { Disposable, LaneId } from '../foundation/model';
import type { Lane, LaneCatalog } from '../lane/model';
import { uriToAbsolutePath } from '../foundation/path';
import type { WorkspaceFolder } from './model';
import type { CatalogStorePort } from './ports';

/**
 * レーンフォルダからのカタログ構築
 * @param lanes - レーンフォルダ列
 * @returns 構築済みカタログ
 */
export const buildCatalog = (lanes: readonly WorkspaceFolder[]): LaneCatalog => {
  const built: Lane[] = lanes.map((f) => ({
    id: f.name as LaneId,
    label: f.name,
    rootUri: f.uri,
    rootPath: uriToAbsolutePath(f.uri),
  }));
  return {
    lanes: built,
    byId: new Map(built.map((l) => [l.id, l])),
  };
};

/**
 * フォルダ列の順序付き等価判定
 * @param a - 比較元
 * @param b - 比較先
 * @returns 同一なら true
 */
const sameFolders = (a: readonly WorkspaceFolder[], b: readonly WorkspaceFolder[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.uri !== b[i]!.uri || a[i]!.name !== b[i]!.name) return false;
  }
  return true;
};

/** レーンカタログの集約 */
export interface WorkspaceCatalogRegistry {
  /**
   * 現在のカタログ取得
   * @returns 現状スナップショット
   */
  readonly snapshot: () => LaneCatalog;
  /**
   * 現在のレーンフォルダ列取得
   * @returns 永続化形式のフォルダ列
   */
  readonly folders: () => readonly WorkspaceFolder[];
  /**
   * 変更通知の購読
   * @param listener - 変更時に呼ばれるリスナー
   * @returns 購読解除可能な Disposable
   */
  readonly onChange: (listener: (catalog: LaneCatalog) => void) => Disposable;
  /**
   * レーン集合の置換
   * @param lanes - 置換後のレーン列
   * @returns 実際に変更が発生すれば true
   */
  readonly replace: (lanes: readonly WorkspaceFolder[]) => boolean;
  /**
   * 未知レーンの追記
   * @param lanes - 追記候補のレーン列
   * @returns 新規追加されたレーン名の列
   */
  readonly absorb: (lanes: readonly WorkspaceFolder[]) => readonly string[];
}

/**
 * レーンカタログ集約の生成
 * @param initial - 初期レーンフォルダ列
 * @param store - カタログ永続化ポート
 * @returns 集約インスタンス
 */
export const createCatalogRegistry = (
  initial: readonly WorkspaceFolder[],
  store: CatalogStorePort,
): WorkspaceCatalogRegistry => {
  let folders: readonly WorkspaceFolder[] = initial;
  let catalog = buildCatalog(folders);
  const listeners = new Set<(c: LaneCatalog) => void>();

  const commit = (next: readonly WorkspaceFolder[]): void => {
    folders = next;
    catalog = buildCatalog(folders);
    store.save(folders);
    for (const listener of listeners) listener(catalog);
  };

  return {
    snapshot: () => catalog,
    folders: () => folders,
    onChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    replace: (next) => {
      if (sameFolders(folders, next)) return false;
      commit(next);
      return true;
    },
    absorb: (incoming) => {
      const known = new Set(folders.map((f) => f.name));
      const additions = incoming.filter((f) => !known.has(f.name));
      if (additions.length === 0) return [];
      commit([...folders, ...additions]);
      return additions.map((f) => f.name);
    },
  };
};
