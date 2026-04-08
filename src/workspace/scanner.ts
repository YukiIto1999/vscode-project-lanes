import * as nodePath from 'node:path';
import type { AbsolutePath, LaneId, UriString, WorkspaceKey } from '../foundation/model';
import type { Lane, LaneCatalog } from '../lane/model';
import { uriToAbsolutePath } from '../foundation/path';
import type {
  FolderMutation,
  WorkspaceAnchor,
  WorkspaceBootstrapResult,
  WorkspaceFolder,
} from './model';
import type { DirectoryPort, WorkspaceHostPort } from './ports';

const ANCHOR_NAME = '.lanes-root' as const;

/** ワークスペースフォルダからアンカーの検出 */
export const detectAnchor = (folders: readonly WorkspaceFolder[]): WorkspaceAnchor | undefined => {
  const first = folders[0];
  if (!first || first.name !== ANCHOR_NAME) return undefined;
  const path = uriToAbsolutePath(first.uri);
  return {
    name: ANCHOR_NAME,
    uri: first.uri,
    path,
    parentPath: nodePath.dirname(path) as AbsolutePath,
  };
};

/** アンカーの親ディレクトリからレーンカタログの構築 */
export const buildCatalog = (
  anchor: WorkspaceAnchor,
  directory: DirectoryPort,
  toUri: (path: string) => UriString,
): LaneCatalog => {
  const entries = directory.listDirectories(anchor.parentPath);
  const lanes: Lane[] = entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => ({
      id: e.name as LaneId,
      label: e.name,
      rootUri: toUri(nodePath.join(anchor.parentPath, e.name)),
      rootPath: e.path,
    }));
  return {
    lanes,
    byId: new Map(lanes.map((l) => [l.id, l])),
  };
};

/** アンカーが存在しなければ作成してワークスペースに挿入 */
const ensureAnchor = (
  folders: readonly WorkspaceFolder[],
  directory: DirectoryPort,
  host: WorkspaceHostPort,
  toUri: (path: string) => UriString,
): readonly WorkspaceFolder[] => {
  if (folders.length === 0) return folders;
  if (folders[0]!.name === ANCHOR_NAME) return folders;

  const parentPath = nodePath.dirname(uriToAbsolutePath(folders[0]!.uri)) as AbsolutePath;
  const anchorPath = nodePath.join(parentPath, ANCHOR_NAME) as AbsolutePath;

  if (!directory.ensureDirectory(anchorPath)) return folders;

  const mutation: FolderMutation = {
    start: 0,
    deleteCount: 0,
    folders: [{ uri: toUri(anchorPath), name: ANCHOR_NAME }],
  };
  host.applyMutation(mutation);
  return host.readFolders();
};

/** ワークスペースのブートストラップ（アンカー未設置なら自動作成） */
export const bootstrapWorkspace = (
  host: WorkspaceHostPort,
  directory: DirectoryPort,
  toUri: (path: string) => UriString,
): WorkspaceBootstrapResult => {
  const folders = ensureAnchor(host.readFolders(), directory, host, toUri);
  if (folders.length === 0) return { kind: 'disabled', reason: 'no-workspace' };
  const anchor = detectAnchor(folders);
  if (!anchor) return { kind: 'disabled', reason: 'missing-anchor' };
  const catalog = buildCatalog(anchor, directory, toUri);
  const key = `filtering:${anchor.parentPath}` as WorkspaceKey;
  return { kind: 'ready', context: { key, anchor, catalog } };
};
