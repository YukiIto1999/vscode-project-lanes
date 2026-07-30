import type { Disposable, LaneId, UriString } from '../foundation/model';
import { type Lane, type LaneCatalog, toLaneId } from '../lane/model';
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
    id: toLaneId(f.name),
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
  readonly replace: (lanes: readonly WorkspaceFolder[]) => Promise<boolean>;
  /**
   * 未知レーンの追記
   * @param lanes - 追記候補のレーン列
   * @returns 新規追加されたレーン名の列
   */
  readonly absorb: (lanes: readonly WorkspaceFolder[]) => Promise<readonly string[]>;
  /**
   * レーンの改名
   * @param oldName - 旧 LaneId を兼ねる改名前 name
   * @param newName - 新 LaneId を兼ねる改名後 name
   * @param beforePublish - 保存後、カタログ公開前に実行する副作用
   * @returns 実際に変更が発生すれば true
   */
  readonly rename: (
    oldName: string,
    newName: string,
    beforePublish?: () => void | Promise<void>,
  ) => Promise<boolean>;
  /**
   * レーンルートの所在変更
   * @param laneId - 変更対象 LaneId
   * @param replacementUri - 置換先 URI
   * @returns 実際に変更が発生すれば true
   */
  readonly relocate: (laneId: LaneId, replacementUri: UriString) => Promise<boolean>;
  /**
   * レーンの除外
   * @param name - LaneId を兼ねる除外対象 name
   * @param beforePublish - 保存後、カタログ公開前に実行する副作用
   * @returns 実際に変更が発生すれば true
   */
  readonly remove: (name: string, beforePublish?: () => void | Promise<void>) => Promise<boolean>;
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
  let tail: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const commit = async (
    next: readonly WorkspaceFolder[],
    beforePublish?: () => void | Promise<void>,
  ): Promise<void> => {
    await store.save(next);
    let effectFailure: { readonly error: unknown } | undefined;
    try {
      await beforePublish?.();
    } catch (error) {
      effectFailure = { error };
    }
    folders = next;
    catalog = buildCatalog(folders);
    for (const listener of listeners) listener(catalog);
    if (effectFailure) throw effectFailure.error;
  };

  return {
    snapshot: () => catalog,
    folders: () => folders,
    onChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    replace: (next) =>
      enqueue(async () => {
        if (sameFolders(folders, next)) return false;
        await commit(next);
        return true;
      }),
    absorb: (incoming) =>
      enqueue(async () => {
        const known = new Set(folders.map((f) => f.name));
        const additions = incoming.filter((f) => !known.has(f.name));
        if (additions.length === 0) return [];
        await commit([...folders, ...additions]);
        return additions.map((f) => f.name);
      }),
    rename: (oldName, newName, beforePublish) =>
      enqueue(async () => {
        if (oldName === newName) return false;
        const idx = folders.findIndex((f) => f.name === oldName);
        if (idx < 0) return false;
        const next = folders.map((f, i) => (i === idx ? { ...f, name: newName } : f));
        await commit(next, beforePublish);
        return true;
      }),
    relocate: (laneId, replacementUri) =>
      enqueue(async () => {
        const idx = folders.findIndex((folder) => folder.name === laneId);
        if (idx < 0 || folders[idx]!.uri === replacementUri) return false;
        const next = folders.map((folder, i) =>
          i === idx ? { ...folder, uri: replacementUri } : folder,
        );
        await commit(next);
        return true;
      }),
    remove: (name, beforePublish) =>
      enqueue(async () => {
        const next = folders.filter((f) => f.name !== name);
        if (next.length === folders.length) return false;
        await commit(next, beforePublish);
        return true;
      }),
  };
};
