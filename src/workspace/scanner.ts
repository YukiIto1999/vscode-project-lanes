import type { AbsolutePath } from '../foundation/model';
import { uriToAbsolutePath } from '../foundation/path';
import { isCanonicalLaneId } from '../lane/model';
import { classifyWorkspaceFolder, deriveWorkspaceAnchor, type WorkspaceAnchor } from './anchor';
import type {
  CatalogEntry,
  WorkspaceBootstrapResult,
  WorkspaceFileInfo,
  WorkspaceFolder,
} from './model';
import type {
  CatalogStorePort,
  DirectoryPort,
  LaneIdFactoryPort,
  WorkspaceHostPort,
} from './ports';

/**
 * レーン候補の純粋抽出
 * @param rawFolders - workspaceFolders の現状
 * @param stored - 永続化されたカタログ
 * @param anchor - 現 workspace の新旧 anchor
 * @param laneIdFactory - 新規レーン識別子採番
 * @returns レーン候補列
 */
export const collectLaneCandidates = (
  rawFolders: readonly WorkspaceFolder[],
  stored: readonly CatalogEntry[] | undefined,
  anchor: WorkspaceAnchor,
  laneIdFactory: LaneIdFactoryPort,
): readonly CatalogEntry[] => {
  const storedRoots = new Set<AbsolutePath>();
  for (const entry of stored ?? []) {
    const rootPath = uriToAbsolutePath(entry.uri);
    if (storedRoots.has(rootPath)) {
      throw new Error('Project Lanes catalog contains a duplicate lane root.');
    }
    storedRoots.add(rootPath);
  }
  for (const folder of rawFolders) uriToAbsolutePath(folder.uri);

  const real = rawFolders.filter((folder) => classifyWorkspaceFolder(folder, anchor) === 'lane');
  const canonicalStored = (stored ?? []).filter(
    (folder) => classifyWorkspaceFolder(folder, anchor) === 'lane',
  );
  const known = new Set(canonicalStored.map((entry) => uriToAbsolutePath(entry.uri)));
  const usedIds = new Set(canonicalStored.map((entry) => entry.id));
  const additions: CatalogEntry[] = [];
  for (const folder of real) {
    const rootPath = uriToAbsolutePath(folder.uri);
    if (known.has(rootPath)) continue;
    const id = laneIdFactory.next();
    if (!isCanonicalLaneId(id)) {
      throw new Error('LaneId factory returned an invalid LaneId.');
    }
    if (usedIds.has(id)) {
      throw new Error('LaneId factory returned a duplicate LaneId.');
    }
    known.add(rootPath);
    usedIds.add(id);
    additions.push({ ...folder, id });
  }
  return [...canonicalStored, ...additions];
};

/**
 * workspaceFolders を symlink folder 1 件へ縮退させる副作用境界
 * @param host - workspaceFolders 操作ポート
 * @param expectedFolders - 変更計画時の workspaceFolders
 * @param linkFolder - 縮退後の単一フォルダ
 * @returns 変更が確定すれば true、VS Code に拒否されれば false
 */
export const collapseFoldersToLink = (
  host: WorkspaceHostPort,
  expectedFolders: readonly WorkspaceFolder[],
  linkFolder: WorkspaceFolder,
): Promise<boolean> =>
  host.applyMutation({
    expectedFolders,
    start: 0,
    deleteCount: expectedFolders.length,
    folders: [linkFolder],
  });

/**
 * ワークスペースのブートストラップ
 * @param host - workspaceFolders 操作ポート
 * @param fileInfo - 確定済みワークスペースファイル情報
 * @param catalogStore - カタログ永続化ポート
 * @param directory - ディレクトリ操作ポート
 * @param laneIdFactory - 新規レーン識別子採番
 * @returns ブートストラップ結果
 */
export const bootstrapWorkspace = async (
  host: Pick<WorkspaceHostPort, 'readFolders'>,
  fileInfo: WorkspaceFileInfo,
  catalogStore: CatalogStorePort,
  directory: DirectoryPort,
  laneIdFactory: LaneIdFactoryPort,
): Promise<WorkspaceBootstrapResult> => {
  const anchor = deriveWorkspaceAnchor(fileInfo);
  const rawFolders = host.readFolders();
  const stored = catalogStore.load();
  const lanes = collectLaneCandidates(rawFolders, stored, anchor, laneIdFactory);

  if (stored === undefined && lanes.length === 0) {
    return { kind: 'disabled', reason: 'missing-lane-source' };
  }

  await catalogStore.save(lanes);

  if (
    !directory.ensureDirectory(anchor.rootDirectoryPath) ||
    !directory.ensureDirectory(anchor.namespaceDirectoryPath)
  ) {
    return { kind: 'disabled', reason: 'missing-anchor' };
  }

  return {
    kind: 'ready',
    context: { key: anchor.workspaceKey, canonicalLanes: lanes },
  };
};
