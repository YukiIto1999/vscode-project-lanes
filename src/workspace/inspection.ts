import * as nodePath from 'node:path';
import { uriToAbsolutePath } from '../foundation/path';
import type { AbsolutePath } from '../foundation/model';
import type {
  CatalogStorePort,
  WorkspaceFilePort,
  WorkspaceHostPort,
  WorkspaceLinkPort,
} from './ports';

/** 管理済みワークスペースと判定した根拠 */
export type WorkspaceManagementEvidence =
  | 'catalog'
  | 'active-folder'
  | 'legacy-anchor'
  | 'active-target';

/** ワークスペース管理状態の検査結果 */
export type WorkspaceInspectionResult =
  | {
      /** workspace file を利用できない */
      readonly kind: 'unsupported';
    }
  | {
      /** Project Lanes の管理情報がない */
      readonly kind: 'unmanaged';
    }
  | {
      /** Project Lanes の管理情報がある */
      readonly kind: 'managed';
      /** 管理済みと判定した根拠 */
      readonly evidence: WorkspaceManagementEvidence;
    };

/** ワークスペース管理状態の読み取りポート */
export interface WorkspaceInspectionPorts {
  /** workspace file の読み取り */
  readonly workspaceFile: Pick<WorkspaceFilePort, 'read'>;
  /** workspaceFolders の読み取り */
  readonly workspaceHost: Pick<WorkspaceHostPort, 'readFolders'>;
  /** catalog の読み取り */
  readonly catalogStore: Pick<CatalogStorePort, 'load'>;
  /** active link target の読み取り */
  readonly link: Pick<WorkspaceLinkPort, 'readTarget'>;
}

/**
 * Project Lanes の管理状態を読み取る
 * @param ports - 管理状態の読み取りポート
 * @returns 管理状態と判定根拠
 */
export const inspectWorkspace = (ports: WorkspaceInspectionPorts): WorkspaceInspectionResult => {
  const fileInfo = ports.workspaceFile.read();
  if (!fileInfo) return { kind: 'unsupported' };

  if (ports.catalogStore.load() !== undefined) {
    return { kind: 'managed', evidence: 'catalog' };
  }

  const activePath = nodePath.join(fileInfo.directoryPath, '.lanes-root', 'active') as AbsolutePath;
  const legacyAnchorPath = nodePath.join(fileInfo.directoryPath, '.lanes-root') as AbsolutePath;
  const rawFolders = ports.workspaceHost.readFolders();
  const rawPaths = rawFolders.map((folder) => uriToAbsolutePath(folder.uri));

  if (rawPaths.includes(activePath)) {
    return { kind: 'managed', evidence: 'active-folder' };
  }
  if (
    rawFolders.some(
      (folder) =>
        folder.name === '.lanes-root' && uriToAbsolutePath(folder.uri) === legacyAnchorPath,
    )
  ) {
    return { kind: 'managed', evidence: 'legacy-anchor' };
  }

  const activeTarget = ports.link.readTarget();
  const normalRawPaths = rawPaths.filter(
    (path) => path !== activePath && path !== legacyAnchorPath,
  );
  if (activeTarget !== undefined && normalRawPaths.includes(activeTarget)) {
    return { kind: 'managed', evidence: 'active-target' };
  }

  return { kind: 'unmanaged' };
};
