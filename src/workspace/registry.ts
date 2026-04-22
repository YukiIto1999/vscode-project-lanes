import type { Disposable, LaneId } from '../foundation/model';
import type { Lane, LaneCatalog } from '../lane/model';
import { uriToAbsolutePath } from '../foundation/path';
import type { WorkspaceFolder } from './model';
import type { CatalogStorePort } from './ports';

/** レーンフォルダからカタログの構築（純粋関数） */
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

/** 2 つの folder 列の順序付き等価判定 */
const sameFolders = (a: readonly WorkspaceFolder[], b: readonly WorkspaceFolder[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.uri !== b[i]!.uri || a[i]!.name !== b[i]!.name) return false;
  }
  return true;
};

/** レーンカタログの集約 */
export interface WorkspaceCatalogRegistry {
  /** 現在のカタログ */
  readonly snapshot: () => LaneCatalog;
  /** 現在のレーンフォルダ列（永続化形式） */
  readonly folders: () => readonly WorkspaceFolder[];
  /** 変更通知の購読 */
  readonly onChange: (listener: (catalog: LaneCatalog) => void) => Disposable;
  /** レーン集合の置換（未変更なら通知しない） */
  readonly replace: (lanes: readonly WorkspaceFolder[]) => boolean;
  /** 未知のレーンを追記、返り値は新規追加ぶんの名前 */
  readonly absorb: (lanes: readonly WorkspaceFolder[]) => readonly string[];
}

/** レーンカタログ集約の生成
 *
 * 不変条件:
 *  - snapshot と folders は常に整合
 *  - replace/absorb の成功時のみ onChange 通知
 *  - 変更時は catalogStore へ永続化
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
