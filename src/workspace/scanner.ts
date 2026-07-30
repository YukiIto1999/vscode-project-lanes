import * as nodePath from 'node:path';
import type { AbsolutePath, UriString, WorkspaceKey } from '../foundation/model';
import { uriToAbsolutePath } from '../foundation/path';
import { isCanonicalLaneId } from '../lane/model';
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
  WorkspaceLinkPort,
} from './ports';

const ANCHOR_DIR_NAME = '.lanes-root' as const;

/**
 * symlink folder の判定
 * @param folder - 判定対象フォルダ
 * @param linkPath - symlink 絶対パス
 * @returns symlink folder なら true
 */
export const isLinkFolder = (folder: WorkspaceFolder, linkPath: AbsolutePath): boolean =>
  uriToAbsolutePath(folder.uri) === linkPath;

/**
 * 旧アンカーフォルダの判定
 * @param folder - 判定対象フォルダ
 * @param legacyAnchorUri - 旧アンカーの絶対 URI
 * @returns 旧アンカーなら true
 */
export const isLegacyAnchor = (folder: WorkspaceFolder, legacyAnchorUri: UriString): boolean =>
  uriToAbsolutePath(folder.uri) === uriToAbsolutePath(legacyAnchorUri);

/**
 * レーン候補の純粋抽出
 * @param rawFolders - workspaceFolders の現状
 * @param stored - 永続化されたカタログ
 * @param linkPath - symlink 絶対パス
 * @param legacyAnchorUri - 旧アンカーの絶対 URI
 * @returns レーン候補列
 */
export const collectLaneCandidates = (
  rawFolders: readonly WorkspaceFolder[],
  stored: readonly CatalogEntry[] | undefined,
  linkPath: AbsolutePath,
  legacyAnchorUri: UriString,
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

  const real = rawFolders.filter(
    (folder) => !isLinkFolder(folder, linkPath) && !isLegacyAnchor(folder, legacyAnchorUri),
  );
  const canonicalStored = (stored ?? []).filter(
    (folder) => !isLegacyAnchor(folder, legacyAnchorUri),
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
 * @param legacyAnchorUri - 旧アンカーの絶対 URI
 * @param link - symlink の所在
 * @param laneIdFactory - 新規レーン識別子採番
 * @returns ブートストラップ結果
 */
export const bootstrapWorkspace = async (
  host: Pick<WorkspaceHostPort, 'readFolders'>,
  fileInfo: WorkspaceFileInfo,
  catalogStore: CatalogStorePort,
  directory: DirectoryPort,
  legacyAnchorUri: UriString,
  link: Pick<WorkspaceLinkPort, 'linkPath'>,
  laneIdFactory: LaneIdFactoryPort,
): Promise<WorkspaceBootstrapResult> => {
  const linkPath = link.linkPath;
  const rawFolders = host.readFolders();
  const stored = catalogStore.load();
  const lanes = collectLaneCandidates(rawFolders, stored, linkPath, legacyAnchorUri, laneIdFactory);

  if (stored === undefined && lanes.length === 0) {
    return { kind: 'disabled', reason: 'missing-lane-source' };
  }

  await catalogStore.save(lanes);

  const anchorDir = nodePath.join(fileInfo.directoryPath, ANCHOR_DIR_NAME) as AbsolutePath;
  if (!directory.ensureDirectory(anchorDir)) {
    return { kind: 'disabled', reason: 'missing-anchor' };
  }

  const key = `workspace:${fileInfo.uri}` as WorkspaceKey;
  return { kind: 'ready', context: { key, canonicalLanes: lanes } };
};
