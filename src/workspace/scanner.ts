import * as nodePath from 'node:path';
import type { AbsolutePath, UriString, WorkspaceKey } from '../foundation/model';
import { uriToAbsolutePath } from '../foundation/path';
import type { WorkspaceAnchor, WorkspaceBootstrapResult, WorkspaceFolder } from './model';
import type {
  CatalogStorePort,
  DirectoryPort,
  WorkspaceFilePort,
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
 * @returns 旧アンカーなら true
 */
export const isLegacyAnchor = (folder: WorkspaceFolder): boolean => folder.name === ANCHOR_DIR_NAME;

/**
 * レーン候補の純粋抽出
 * @param rawFolders - workspaceFolders の現状
 * @param stored - 永続化されたカタログ
 * @param linkPath - symlink 絶対パス
 * @returns レーン候補列
 */
export const collectLaneCandidates = (
  rawFolders: readonly WorkspaceFolder[],
  stored: readonly WorkspaceFolder[] | undefined,
  linkPath: AbsolutePath,
): readonly WorkspaceFolder[] => {
  const real = rawFolders.filter((f) => !isLinkFolder(f, linkPath) && !isLegacyAnchor(f));
  if (!stored || stored.length === 0) return real;
  const known = new Set(stored.map((s) => s.uri));
  const additions = real.filter((f) => !known.has(f.uri));
  return [...stored, ...additions];
};

/**
 * アクティブレーンの選定
 * @param lanes - レーン候補列
 * @param currentLinkTarget - 現 symlink target
 * @returns 選定レーン、または候補が空のとき undefined
 */
export const chooseActiveLane = (
  lanes: readonly WorkspaceFolder[],
  currentLinkTarget: AbsolutePath | undefined,
): WorkspaceFolder | undefined => {
  if (lanes.length === 0) return undefined;
  if (currentLinkTarget) {
    const matching = lanes.find((l) => uriToAbsolutePath(l.uri) === currentLinkTarget);
    if (matching) return matching;
  }
  return lanes[0];
};

/**
 * アンカー情報の構築
 * @param path - アンカー絶対パス
 * @param toUri - パスから URI への変換
 * @returns アンカー情報
 */
const buildAnchor = (path: AbsolutePath, toUri: (path: string) => UriString): WorkspaceAnchor => ({
  name: ANCHOR_DIR_NAME,
  uri: toUri(path),
  path,
  parentPath: nodePath.dirname(path) as AbsolutePath,
});

/**
 * ワークスペースのブートストラップ
 * @param host - workspaceFolders 操作ポート
 * @param workspaceFile - ワークスペースファイル参照ポート
 * @param catalogStore - カタログ永続化ポート
 * @param directory - ディレクトリ操作ポート
 * @param link - symlink 操作ポート
 * @param toUri - パスから URI への変換
 * @returns ブートストラップ結果
 */
export const bootstrapWorkspace = (
  host: WorkspaceHostPort,
  workspaceFile: WorkspaceFilePort,
  catalogStore: CatalogStorePort,
  directory: DirectoryPort,
  link: WorkspaceLinkPort,
  toUri: (path: string) => UriString,
): WorkspaceBootstrapResult => {
  const fileInfo = workspaceFile.read();
  if (!fileInfo) return { kind: 'disabled', reason: 'no-workspace-file' };

  const anchorDir = nodePath.join(fileInfo.directoryPath, ANCHOR_DIR_NAME) as AbsolutePath;
  if (!directory.ensureDirectory(anchorDir)) {
    return { kind: 'disabled', reason: 'missing-anchor' };
  }

  const linkPath = link.linkPath;
  const rawFolders = host.readFolders();
  const stored = catalogStore.load();
  const currentLinkTarget = link.readTarget();

  const lanes = collectLaneCandidates(rawFolders, stored, linkPath);
  const activeLane = chooseActiveLane(lanes, currentLinkTarget);

  if (!activeLane) {
    catalogStore.save([]);
    const anchor = buildAnchor(anchorDir, toUri);
    const key = `workspace:${fileInfo.uri}` as WorkspaceKey;
    return { kind: 'ready', context: { key, anchor, canonicalLanes: [] } };
  }

  const activePath = uriToAbsolutePath(activeLane.uri);

  if (currentLinkTarget !== activePath) {
    link.swap(activePath);
  }

  const linkFolder: WorkspaceFolder = {
    uri: toUri(linkPath),
    name: activeLane.name,
  };
  const needsFolderUpdate =
    rawFolders.length !== 1 ||
    !isLinkFolder(rawFolders[0]!, linkPath) ||
    rawFolders[0]!.name !== activeLane.name;

  if (needsFolderUpdate) {
    host.applyMutation({
      start: 0,
      deleteCount: rawFolders.length,
      folders: [linkFolder],
    });
  }

  catalogStore.save(lanes);

  const anchor = buildAnchor(anchorDir, toUri);
  const key = `workspace:${fileInfo.uri}` as WorkspaceKey;
  return { kind: 'ready', context: { key, anchor, canonicalLanes: lanes } };
};
