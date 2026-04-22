import * as vscode from 'vscode';
import type { LaneId, UriString } from '../../foundation/model';
import type { LaneSelectionStorePort } from '../../lane/ports';
import type { WorkspaceFolder } from '../../workspace/model';
import type { CatalogStorePort } from '../../workspace/ports';

const CATALOG_KEY = 'projectLanes.catalog' as const;

/** VS Code globalState によるレーン選択の永続化アダプター */
export const createSelectionStoreAdapter = (
  globalState: vscode.Memento,
): LaneSelectionStorePort => ({
  load: (key) => globalState.get<LaneId>(key),
  save: (key, laneId) => {
    globalState.update(key, laneId);
  },
});

/** シリアライズ用のワークスペースフォルダ表現 */
interface StoredFolder {
  readonly uri: string;
  readonly name: string;
}

/** VS Code workspaceState によるレーンカタログの永続化アダプター */
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
