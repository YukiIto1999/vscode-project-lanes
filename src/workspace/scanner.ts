import * as nodePath from 'node:path';
import type { AbsolutePath, UriString, WorkspaceKey } from '../foundation/model';
import { uriToAbsolutePath } from '../foundation/path';
import type { WorkspaceBootstrapResult, WorkspaceFileInfo, WorkspaceFolder } from './model';
import type {
  CatalogStorePort,
  DirectoryPort,
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
  folder.uri === legacyAnchorUri;

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
  stored: readonly WorkspaceFolder[] | undefined,
  linkPath: AbsolutePath,
  legacyAnchorUri: UriString,
): readonly WorkspaceFolder[] => {
  const real = rawFolders.filter(
    (folder) => !isLinkFolder(folder, linkPath) && !isLegacyAnchor(folder, legacyAnchorUri),
  );
  if (!stored || stored.length === 0) return real;
  const known = new Set(stored.map((s) => s.uri));
  const additions = real.filter((f) => !known.has(f.uri));
  return [...stored, ...additions];
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
 * @returns ブートストラップ結果
 */
export const bootstrapWorkspace = async (
  host: Pick<WorkspaceHostPort, 'readFolders'>,
  fileInfo: WorkspaceFileInfo,
  catalogStore: CatalogStorePort,
  directory: DirectoryPort,
  legacyAnchorUri: UriString,
  link: Pick<WorkspaceLinkPort, 'linkPath'>,
): Promise<WorkspaceBootstrapResult> => {
  const linkPath = link.linkPath;
  const rawFolders = host.readFolders();
  const stored = catalogStore.load();
  const lanes = collectLaneCandidates(rawFolders, stored, linkPath, legacyAnchorUri);

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
