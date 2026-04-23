import * as vscode from 'vscode';
import type { LaneId, UriString } from '../../foundation/model';
import type { LaneSelectionStorePort } from '../../lane/ports';
import type { WorkspaceFolder } from '../../workspace/model';
import type { CatalogStorePort } from '../../workspace/ports';

const CATALOG_KEY = 'projectLanes.catalog' as const;

/**
 * レーン選択永続化アダプターの生成
 * @param memento - 永続化対象 Memento
 * @returns レーン選択永続化ポート
 */
export const createSelectionStoreAdapter = (memento: vscode.Memento): LaneSelectionStorePort => ({
  load: (key) => memento.get<LaneId>(key),
  save: (key, laneId) => {
    memento.update(key, laneId);
  },
});

/** シリアライズ用ワークスペースフォルダ表現 */
interface StoredFolder {
  /** フォルダ URI 文字列 */
  readonly uri: string;
  /** 表示名 */
  readonly name: string;
}

/**
 * カタログ永続化アダプターの生成
 * @param workspaceState - 永続化対象 Memento
 * @returns カタログ永続化ポート
 */
export const createCatalogStoreAdapter = (workspaceState: vscode.Memento): CatalogStorePort => ({
  load: () => {
    const raw = workspaceState.get<readonly StoredFolder[]>(CATALOG_KEY);
    if (!raw) return undefined;
    return raw.map((f): WorkspaceFolder => ({ uri: f.uri as UriString, name: f.name }));
  },
  save: (folders) => {
    const serialized: readonly StoredFolder[] = folders.map((f) => ({
      uri: f.uri as string,
      name: f.name,
    }));
    workspaceState.update(CATALOG_KEY, serialized);
  },
});
