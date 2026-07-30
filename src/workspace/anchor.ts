import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import type { AbsolutePath, WorkspaceKey } from '../foundation/model';
import { uriToAbsolutePath } from '../foundation/path';
import type { WorkspaceFileInfo, WorkspaceFolder } from './model';

const ANCHOR_DIRECTORY_NAME = '.lanes-root';
const ACTIVE_LINK_NAME = 'active';
const WORKSPACE_ANCHOR_HASH_PREFIX = 'project-lanes:workspace-anchor:v1\0';

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
export type WorkspaceFolderRole = 'active-link' | 'legacy-active-link' | 'legacy-anchor' | 'lane';

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
  return 'lane';
};
