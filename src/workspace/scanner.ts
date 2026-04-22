import * as nodePath from 'node:path';
import type { AbsolutePath, UriString, WorkspaceKey } from '../foundation/model';
import { uriToAbsolutePath } from '../foundation/path';
import type {
  FolderMutation,
  WorkspaceAnchor,
  WorkspaceBootstrapResult,
  WorkspaceFileInfo,
  WorkspaceFolder,
} from './model';
import type {
  CatalogStorePort,
  DirectoryPort,
  WorkspaceFilePort,
  WorkspaceHostPort,
} from './ports';

const ANCHOR_NAME = '.lanes-root' as const;

/** アンカーの判定 */
export const isAnchor = (folder: WorkspaceFolder): boolean => folder.name === ANCHOR_NAME;

/** workspaceFolders からレーン正本を解決
 *
 * unfocused（アンカー以外が 2 件以上、または stored 未保存）のときは workspaceFolders が正本、
 * focused（縮退中）のときは stored catalog を正本として返す
 */
export const resolveCanonicalLanes = (
  rawFolders: readonly WorkspaceFolder[],
  stored: readonly WorkspaceFolder[] | undefined,
): readonly WorkspaceFolder[] => {
  const nonAnchor = rawFolders.filter((f) => !isAnchor(f));
  if (!stored || nonAnchor.length >= 2) return nonAnchor;
  return stored;
};

/** アンカーメタデータの構築 */
const buildAnchor = (path: AbsolutePath, toUri: (path: string) => UriString): WorkspaceAnchor => ({
  name: ANCHOR_NAME,
  uri: toUri(path),
  path,
  parentPath: nodePath.dirname(path) as AbsolutePath,
});

/** アンカーが無ければ作成し workspaceFolders の先頭に挿入 */
const ensureAnchor = (
  rawFolders: readonly WorkspaceFolder[],
  workspaceFile: WorkspaceFileInfo,
  directory: DirectoryPort,
  host: WorkspaceHostPort,
  toUri: (path: string) => UriString,
): WorkspaceAnchor | undefined => {
  const existing = rawFolders[0];
  if (existing && isAnchor(existing)) {
    return buildAnchor(uriToAbsolutePath(existing.uri), toUri);
  }

  const anchorPath = nodePath.join(workspaceFile.directoryPath, ANCHOR_NAME) as AbsolutePath;
  if (!directory.ensureDirectory(anchorPath)) return undefined;

  const mutation: FolderMutation = {
    start: 0,
    deleteCount: 0,
    folders: [{ uri: toUri(anchorPath), name: ANCHOR_NAME }],
  };
  host.applyMutation(mutation);
  return buildAnchor(anchorPath, toUri);
};

/** ワークスペースのブートストラップ
 *
 * 正本 = workspace ファイル（存在の確認）+ stored catalog（workspaceState）。
 * フォーカス操作が `.code-workspace` を縮退させても stored から全レーン復元。
 */
export const bootstrapWorkspace = (
  host: WorkspaceHostPort,
  workspaceFile: WorkspaceFilePort,
  catalogStore: CatalogStorePort,
  directory: DirectoryPort,
  toUri: (path: string) => UriString,
): WorkspaceBootstrapResult => {
  const fileInfo = workspaceFile.read();
  if (!fileInfo) return { kind: 'disabled', reason: 'no-workspace-file' };

  const rawFolders = host.readFolders();
  const stored = catalogStore.load();
  const canonicalLanes = resolveCanonicalLanes(rawFolders, stored);

  // 0 件は「これからプロジェクトを登録していく」初期状態として許容
  catalogStore.save(canonicalLanes);

  const anchor = ensureAnchor(rawFolders, fileInfo, directory, host, toUri);
  if (!anchor) return { kind: 'disabled', reason: 'missing-anchor' };

  const key = `workspace:${fileInfo.uri}` as WorkspaceKey;
  return { kind: 'ready', context: { key, anchor, canonicalLanes } };
};
