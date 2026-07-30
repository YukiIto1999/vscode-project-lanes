import { classifyWorkspaceFolder, deriveWorkspaceAnchor } from './anchor';
import type { CatalogStorePort, WorkspaceFilePort, WorkspaceHostPort } from './ports';

/** 管理済みワークスペースと判定した根拠 */
export type WorkspaceManagementEvidence = 'catalog' | 'active-folder' | 'legacy-anchor';

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

  const anchor = deriveWorkspaceAnchor(fileInfo);
  const rawFolders = ports.workspaceHost.readFolders();
  const roles = rawFolders.map((folder) => classifyWorkspaceFolder(folder, anchor));
  if (roles.includes('active-link') || roles.includes('legacy-active-link')) {
    return { kind: 'managed', evidence: 'active-folder' };
  }
  if (roles.includes('legacy-anchor')) {
    return { kind: 'managed', evidence: 'legacy-anchor' };
  }

  return { kind: 'unmanaged' };
};
