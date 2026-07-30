import type * as vscode from 'vscode';
import type { LaneId, UriString } from '../../foundation/model';
import { isCanonicalLaneId, toLaneId, type EditorSnapshot } from '../../lane/model';
import type { EditorSnapshotPruneResult, EditorSnapshotStorePort } from '../../lane/ports';

const EDITOR_SNAPSHOTS_KEY = 'projectLanes.editorSnapshots' as const;
const EDITOR_SNAPSHOTS_SCHEMA_VERSION = 1 as const;
const MINIMUM_VIEW_COLUMN = 1;
const MAXIMUM_VIEW_COLUMN = 9;

interface StoredEditorSnapshotsV1 {
  /** スキーマ版 */
  readonly schemaVersion: typeof EDITOR_SNAPSHOTS_SCHEMA_VERSION;
  /** レーン識別子ごとのエディタ状態 */
  readonly byLaneId: Readonly<Record<string, EditorSnapshot>>;
}

interface DecodedEditorSnapshots {
  /** 読込済みエディタ状態 */
  readonly snapshots: ReadonlyMap<LaneId, EditorSnapshot>;
  /** 上書きを禁止する未知の将来スキーマ版 */
  readonly protectedSchemaVersion?: number;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isFileUri = (value: unknown): value is UriString => {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
};

const isViewColumn = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= MINIMUM_VIEW_COLUMN &&
  value <= MAXIMUM_VIEW_COLUMN;

const copySnapshot = (snapshot: EditorSnapshot): EditorSnapshot => ({
  tabs: snapshot.tabs.map((tab) => ({ uri: tab.uri, viewColumn: tab.viewColumn })),
});

const parseSnapshot = (value: unknown): EditorSnapshot | undefined => {
  if (!isRecord(value) || !Array.isArray(value.tabs)) return undefined;

  const tabs = [];
  const seen = new Set<string>();
  for (const rawTab of value.tabs) {
    if (!isRecord(rawTab) || !isFileUri(rawTab.uri) || !isViewColumn(rawTab.viewColumn)) {
      return undefined;
    }
    const key = `${rawTab.uri}\0${rawTab.viewColumn}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push({ uri: rawTab.uri, viewColumn: rawTab.viewColumn });
  }
  return { tabs };
};

const decodeEditorSnapshots = (raw: unknown): DecodedEditorSnapshots => {
  if (isRecord(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > 1) {
    return {
      snapshots: new Map(),
      protectedSchemaVersion: raw.schemaVersion,
    };
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== EDITOR_SNAPSHOTS_SCHEMA_VERSION ||
    !isRecord(raw.byLaneId)
  ) {
    return { snapshots: new Map() };
  }

  const snapshots = new Map<LaneId, EditorSnapshot>();
  for (const [rawLaneId, rawSnapshot] of Object.entries(raw.byLaneId)) {
    if (!isCanonicalLaneId(rawLaneId)) continue;
    const snapshot = parseSnapshot(rawSnapshot);
    if (snapshot) snapshots.set(toLaneId(rawLaneId), snapshot);
  }
  return { snapshots };
};

const serializeEditorSnapshots = (
  snapshots: ReadonlyMap<LaneId, EditorSnapshot>,
): StoredEditorSnapshotsV1 => ({
  schemaVersion: EDITOR_SNAPSHOTS_SCHEMA_VERSION,
  byLaneId: Object.fromEntries(
    [...snapshots].map(([laneId, snapshot]) => [laneId, copySnapshot(snapshot)]),
  ),
});

/**
 * VS Code workspaceState によるエディタ状態ストアの生成
 * @param workspaceState - 永続化対象 Memento
 * @returns エディタ状態永続化ポート
 */
export const createEditorSnapshotStoreAdapter = (
  workspaceState: vscode.Memento,
): EditorSnapshotStorePort => {
  const decoded = decodeEditorSnapshots(workspaceState.get<unknown>(EDITOR_SNAPSHOTS_KEY));
  let snapshots = new Map(decoded.snapshots);
  let tail: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const assertWritableSchema = (): void => {
    if (decoded.protectedSchemaVersion !== undefined) {
      throw new Error(
        `Unsupported Project Lanes editor snapshot schema version: ${decoded.protectedSchemaVersion}`,
      );
    }
  };

  return {
    get: (laneId) => {
      const snapshot = snapshots.get(laneId);
      return snapshot ? copySnapshot(snapshot) : undefined;
    },
    save: (laneId, rawSnapshot) => {
      if (!isCanonicalLaneId(laneId)) {
        return Promise.reject(new Error('Invalid editor snapshot LaneId.'));
      }
      const snapshot = parseSnapshot(rawSnapshot);
      if (!snapshot) return Promise.reject(new Error('Invalid editor snapshot.'));

      return enqueue(async () => {
        assertWritableSchema();
        const next = new Map(snapshots);
        next.set(laneId, copySnapshot(snapshot));
        await workspaceState.update(EDITOR_SNAPSHOTS_KEY, serializeEditorSnapshots(next));
        snapshots = next;
      });
    },
    remove: (laneId) =>
      enqueue(async () => {
        assertWritableSchema();
        if (!snapshots.has(laneId)) return;
        const next = new Map(snapshots);
        next.delete(laneId);
        await workspaceState.update(EDITOR_SNAPSHOTS_KEY, serializeEditorSnapshots(next));
        snapshots = next;
      }),
    prune: (retainedLaneIds) =>
      enqueue(async (): Promise<EditorSnapshotPruneResult> => {
        if (decoded.protectedSchemaVersion !== undefined) return 'protected';

        const retained = new Set(retainedLaneIds);
        const next = new Map([...snapshots].filter(([laneId]) => retained.has(laneId)));
        if (next.size === snapshots.size) return 'unchanged';

        await workspaceState.update(EDITOR_SNAPSHOTS_KEY, serializeEditorSnapshots(next));
        snapshots = next;
        return 'pruned';
      }),
  };
};
