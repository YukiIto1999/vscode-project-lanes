import type { Disposable, LaneId, UriString } from '../foundation/model';
import { isCanonicalLaneId, type Lane, type LaneCatalog } from '../lane/model';
import { uriToAbsolutePath } from '../foundation/path';
import type { CatalogEntry, WorkspaceFolder } from './model';
import type { CatalogStorePort, LaneIdFactoryPort } from './ports';

/**
 * レーンフォルダからのカタログ構築
 * @param lanes - レーンフォルダ列
 * @returns 構築済みカタログ
 */
export const buildCatalog = (lanes: readonly CatalogEntry[]): LaneCatalog => {
  const built: Lane[] = lanes.map((f) => ({
    id: f.id,
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
const sameFolders = (a: readonly CatalogEntry[], b: readonly CatalogEntry[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id || a[i]!.uri !== b[i]!.uri || a[i]!.name !== b[i]!.name) {
      return false;
    }
  }
  return true;
};

const assertCatalogInvariants = (entries: readonly CatalogEntry[]): void => {
  const ids = new Set<LaneId>();
  const roots = new Set<string>();
  for (const entry of entries) {
    const rootPath = uriToAbsolutePath(entry.uri);
    if (ids.has(entry.id)) throw new Error('Duplicate LaneId in catalog.');
    if (roots.has(rootPath)) throw new Error('Duplicate lane root in catalog.');
    ids.add(entry.id);
    roots.add(rootPath);
  }
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
  readonly folders: () => readonly CatalogEntry[];
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
  readonly replace: (lanes: readonly CatalogEntry[]) => Promise<boolean>;
  /**
   * 未知レーンの追記
   * @param lanes - 追記候補のレーン列
   * @returns 新規追加されたレーン名の列
   */
  readonly absorb: (lanes: readonly WorkspaceFolder[]) => Promise<readonly string[]>;
  /**
   * レーンの改名
   * @param laneId - 対象レーン識別子
   * @param newName - 改名後表示名
   * @param beforePublish - 保存後、カタログ公開前に実行する副作用
   * @returns 実際に変更が発生すれば true
   */
  readonly rename: (
    laneId: LaneId,
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
   * @param laneId - 除外対象レーン識別子
   * @param beforePublish - 保存後、カタログ公開前に実行する副作用
   * @returns 実際に変更が発生すれば true
   */
  readonly remove: (laneId: LaneId, beforePublish?: () => void | Promise<void>) => Promise<boolean>;
}

/**
 * レーンカタログ集約の生成
 * @param initial - 初期レーンフォルダ列
 * @param store - カタログ永続化ポート
 * @param laneIdFactory - 新規レーン識別子採番
 * @returns 集約インスタンス
 */
export const createCatalogRegistry = (
  initial: readonly CatalogEntry[],
  store: CatalogStorePort,
  laneIdFactory: LaneIdFactoryPort,
): WorkspaceCatalogRegistry => {
  assertCatalogInvariants(initial);
  let folders: readonly CatalogEntry[] = initial;
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
    next: readonly CatalogEntry[],
    beforePublish?: () => void | Promise<void>,
  ): Promise<void> => {
    assertCatalogInvariants(next);
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
        const known = new Set(folders.map((f) => uriToAbsolutePath(f.uri)));
        const usedIds = new Set(folders.map((f) => f.id));
        const additions: CatalogEntry[] = [];
        for (const folder of incoming) {
          const rootPath = uriToAbsolutePath(folder.uri);
          if (known.has(rootPath)) continue;
          const id = laneIdFactory.next();
          if (!isCanonicalLaneId(id)) {
            throw new Error('LaneId factory returned an invalid LaneId.');
          }
          if (usedIds.has(id)) throw new Error('LaneId factory returned a duplicate identifier.');
          known.add(rootPath);
          usedIds.add(id);
          additions.push({ ...folder, id });
        }
        if (additions.length === 0) return [];
        await commit([...folders, ...additions]);
        return additions.map((f) => f.name);
      }),
    rename: (laneId, newName, beforePublish) =>
      enqueue(async () => {
        const idx = folders.findIndex((f) => f.id === laneId);
        if (idx < 0) return false;
        if (folders[idx]!.name === newName) return false;
        const next = folders.map((f, i) => (i === idx ? { ...f, name: newName } : f));
        await commit(next, beforePublish);
        return true;
      }),
    relocate: (laneId, replacementUri) =>
      enqueue(async () => {
        const idx = folders.findIndex((folder) => folder.id === laneId);
        if (idx < 0) return false;
        const replacementRoot = uriToAbsolutePath(replacementUri);
        if (uriToAbsolutePath(folders[idx]!.uri) === replacementRoot) return false;
        if (
          folders.some(
            (folder, i) => i !== idx && uriToAbsolutePath(folder.uri) === replacementRoot,
          )
        ) {
          return false;
        }
        const next = folders.map((folder, i) =>
          i === idx ? { ...folder, uri: replacementUri } : folder,
        );
        await commit(next);
        return true;
      }),
    remove: (laneId, beforePublish) =>
      enqueue(async () => {
        const next = folders.filter((f) => f.id !== laneId);
        if (next.length === folders.length) return false;
        await commit(next, beforePublish);
        return true;
      }),
  };
};
