import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import type { UriString } from '../../foundation/model';
import { uriToAbsolutePath } from '../../foundation/path';
import { isCanonicalLaneId, toLaneId } from '../../lane/model';
import type { LaneSelectionStorePort } from '../../lane/ports';
import type { CatalogEntry } from '../../workspace/model';
import type { CatalogStorePort } from '../../workspace/ports';

const CATALOG_KEY = 'projectLanes.catalog' as const;

/**
 * レーン選択永続化アダプターの生成
 * @param memento - 永続化対象 Memento
 * @returns レーン選択永続化ポート
 */
export const createSelectionStoreAdapter = (memento: vscode.Memento): LaneSelectionStorePort => ({
  load: (key) => {
    const raw = memento.get<unknown>(key);
    if (typeof raw === 'string') return { kind: 'legacy', label: raw };
    if (
      raw !== null &&
      typeof raw === 'object' &&
      (raw as { schemaVersion?: unknown }).schemaVersion === 2 &&
      typeof (raw as { laneId?: unknown }).laneId === 'string' &&
      isCanonicalLaneId((raw as { laneId: string }).laneId)
    ) {
      return { kind: 'v2', laneId: toLaneId((raw as { laneId: string }).laneId) };
    }
    return undefined;
  },
  save: async (key, laneId) => {
    await memento.update(key, laneId ? { schemaVersion: 2, laneId } : undefined);
  },
});

/** v0.1.13 以前のカタログ行 */
interface StoredFolderV1 {
  /** フォルダ URI 文字列 */
  readonly uri: string;
  /** 表示名 */
  readonly name: string;
}

/** 現行カタログ行 */
interface StoredCatalogEntryV2 extends StoredFolderV1 {
  /** スキーマ版 */
  readonly schemaVersion: 2;
  /** 不透明識別子 */
  readonly id: string;
}

/** カタログ形式エラー */
class InvalidStoredCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStoredCatalogError';
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const parseStoredV2 = (value: unknown): StoredCatalogEntryV2 | undefined => {
  if (!isRecord(value) || value.schemaVersion !== 2) return undefined;
  if (
    typeof value.id !== 'string' ||
    !isCanonicalLaneId(value.id) ||
    !isNonEmptyString(value.uri) ||
    !isNonEmptyString(value.name)
  ) {
    throw new InvalidStoredCatalogError('Invalid Project Lanes catalog v2 row.');
  }
  return {
    schemaVersion: 2,
    id: value.id,
    uri: value.uri,
    name: value.name,
  };
};

const parseStoredV1 = (value: unknown): StoredFolderV1 => {
  if (
    !isRecord(value) ||
    'schemaVersion' in value ||
    !isNonEmptyString(value.uri) ||
    !isNonEmptyString(value.name)
  ) {
    throw new InvalidStoredCatalogError('Invalid Project Lanes legacy catalog row.');
  }
  return { uri: value.uri, name: value.name };
};

const migratedLaneId = (rootPath: string, occurrence: number, salt: number): string =>
  createHash('sha256')
    .update(`project-lanes:catalog:v2\0${rootPath}\0${occurrence}\0${salt}`)
    .digest('hex');

const decodeCatalog = (raw: unknown): readonly CatalogEntry[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new InvalidStoredCatalogError('Project Lanes catalog must be an array.');
  }

  const parsedV2 = raw.map(parseStoredV2);
  const parsedV1 = raw.map((value, index) =>
    parsedV2[index] === undefined ? parseStoredV1(value) : undefined,
  );
  const reservedIds = new Set<string>();
  const roots = new Set<string>();
  for (const [index, row] of parsedV2.entries()) {
    const id = row?.id;
    const uri = row?.uri ?? parsedV1[index]!.uri;
    const rootPath = uriToAbsolutePath(uri as UriString);
    if (id !== undefined && reservedIds.has(id)) {
      throw new InvalidStoredCatalogError('Project Lanes catalog contains a duplicate LaneId.');
    }
    if (roots.has(rootPath)) {
      throw new InvalidStoredCatalogError('Project Lanes catalog contains a duplicate lane root.');
    }
    if (id !== undefined) reservedIds.add(id);
    roots.add(rootPath);
  }

  const occurrences = new Map<string, number>();
  return raw.map((value, index): CatalogEntry => {
    const v2 = parsedV2[index];
    if (v2) {
      return {
        id: toLaneId(v2.id),
        uri: v2.uri as UriString,
        name: v2.name,
      };
    }

    const v1 = parsedV1[index]!;
    const rootPath = uriToAbsolutePath(v1.uri as UriString);
    const occurrence = occurrences.get(rootPath) ?? 0;
    occurrences.set(rootPath, occurrence + 1);
    let salt = 0;
    let id = migratedLaneId(rootPath, occurrence, salt);
    while (reservedIds.has(id)) {
      salt += 1;
      id = migratedLaneId(rootPath, occurrence, salt);
    }
    reservedIds.add(id);
    return { id: toLaneId(id), uri: v1.uri as UriString, name: v1.name };
  });
};

/**
 * カタログ永続化アダプターの生成
 * @param workspaceState - 永続化対象 Memento
 * @returns カタログ永続化ポート
 */
export const createCatalogStoreAdapter = (workspaceState: vscode.Memento): CatalogStorePort => ({
  load: () => decodeCatalog(workspaceState.get<unknown>(CATALOG_KEY)),
  save: async (folders) => {
    const serialized: readonly StoredCatalogEntryV2[] = folders.map((f) => ({
      schemaVersion: 2,
      id: f.id,
      uri: f.uri as string,
      name: f.name,
    }));
    await workspaceState.update(CATALOG_KEY, serialized);
  },
});
