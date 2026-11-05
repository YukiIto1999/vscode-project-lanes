import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import type { AbsolutePath, WorkspaceKey } from '../foundation/model';
import { uriToAbsolutePath } from '../foundation/path';
import type { WorkspaceFileInfo, WorkspaceFolder } from './model';
import type { AnchorTargetPort } from './ports';

const ANCHOR_DIRECTORY_NAME = '.lanes-root';
const ACTIVE_LINK_NAME = 'active';
const WORKSPACE_ANCHOR_HASH_PREFIX = 'project-lanes:workspace-anchor:v1\0';
const WORKSPACE_ANCHOR_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** workspace file ごとに導出した anchor の所在 */
export interface WorkspaceAnchor {
  /** workspaceState と selection cache に使う既存互換キー */
  readonly workspaceKey: WorkspaceKey;
  /** workspace key の versioned SHA-256 */
  readonly hash: string;
  /** 全 workspace が共有する `.lanes-root` */
  readonly rootDirectoryPath: AbsolutePath;
  /** 現 workspace 専用の hash directory */
  readonly namespaceDirectoryPath: AbsolutePath;
  /** 現 workspace 専用の active link */
  readonly activeLinkPath: AbsolutePath;
  /** v0.1.13 以前が共有していた active link */
  readonly legacyActiveLinkPath: AbsolutePath;
}

/** workspaceFolders 内の folder が担う役割 */
export type WorkspaceFolderRole =
  | 'active-link'
  | 'legacy-active-link'
  | 'legacy-anchor'
  | 'foreign-anchor'
  | 'lane';

/**
 * workspace file から専用 anchor を導出する
 * @param fileInfo - workspace file の URI と所在
 * @returns workspace key と新旧 anchor path
 */
export const deriveWorkspaceAnchor = (fileInfo: WorkspaceFileInfo): WorkspaceAnchor => {
  const workspaceKey = `workspace:${fileInfo.uri}` as WorkspaceKey;
  const hash = createHash('sha256')
    .update(`${WORKSPACE_ANCHOR_HASH_PREFIX}${workspaceKey}`)
    .digest('hex');
  const rootDirectoryPath = nodePath.join(
    fileInfo.directoryPath,
    ANCHOR_DIRECTORY_NAME,
  ) as AbsolutePath;
  const namespaceDirectoryPath = nodePath.join(rootDirectoryPath, hash) as AbsolutePath;

  return {
    workspaceKey,
    hash,
    rootDirectoryPath,
    namespaceDirectoryPath,
    activeLinkPath: nodePath.join(namespaceDirectoryPath, ACTIVE_LINK_NAME) as AbsolutePath,
    legacyActiveLinkPath: nodePath.join(rootDirectoryPath, ACTIVE_LINK_NAME) as AbsolutePath,
  };
};

/**
 * 任意 workspace の namespaced active link と同じ path 形状かの判定
 * @param path - 判定対象
 * @returns `.lanes-root/<hash>/active` 形状なら true
 */
const isNamespacedActiveLinkPath = (path: AbsolutePath): boolean => {
  const namespaceDirectoryPath = nodePath.dirname(path);
  return (
    nodePath.basename(path) === ACTIVE_LINK_NAME &&
    WORKSPACE_ANCHOR_HASH_PATTERN.test(nodePath.basename(namespaceDirectoryPath)) &&
    nodePath.basename(nodePath.dirname(namespaceDirectoryPath)) === ANCHOR_DIRECTORY_NAME
  );
};

/**
 * workspace folder を path だけで分類する
 * @param folder - 判定対象
 * @param anchor - 現 workspace の anchor
 * @returns 現 workspace における役割
 */
export const classifyWorkspaceFolder = (
  folder: WorkspaceFolder,
  anchor: WorkspaceAnchor,
): WorkspaceFolderRole => {
  const path = uriToAbsolutePath(folder.uri);
  if (path === anchor.activeLinkPath) return 'active-link';
  if (path === anchor.legacyActiveLinkPath) return 'legacy-active-link';
  if (path === anchor.rootDirectoryPath) return 'legacy-anchor';
  if (
    path.startsWith(`${anchor.rootDirectoryPath}${nodePath.sep}`) ||
    isNamespacedActiveLinkPath(path)
  ) {
    return 'foreign-anchor';
  }
  return 'lane';
};

/**
 * workspace folder から lane 候補への解決
 * 他 workspace の anchor folder は参照先が利用可能な directory の場合だけ、その参照先を root とする
 * @param folder - 判定対象
 * @param anchor - 現 workspace の anchor
 * @param anchorTarget - anchor folder の参照先解決
 * @returns lane 候補、system folder または復元不能な anchor folder なら undefined
 */
export const resolveLaneCandidate = <T extends WorkspaceFolder>(
  folder: T,
  anchor: WorkspaceAnchor,
  anchorTarget: AnchorTargetPort,
): T | undefined => {
  const role = classifyWorkspaceFolder(folder, anchor);
  if (role === 'lane') return folder;
  if (role !== 'foreign-anchor') return undefined;
  const uri = anchorTarget.resolve(uriToAbsolutePath(folder.uri));
  if (uri === undefined) return undefined;
  const recovered = { ...folder, uri };
  return classifyWorkspaceFolder(recovered, anchor) === 'lane' ? recovered : undefined;
};
