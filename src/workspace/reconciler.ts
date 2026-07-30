import type { OperationQueue } from '../foundation/operation-queue';
import type { WorkspaceFolder } from './model';
import type { WorkspaceHostPort } from './ports';
import { classifyWorkspaceFolder, type WorkspaceAnchor } from './anchor';

/** ユーザー操作による workspaceFolders 変化への応答アクション */
export type ReconciliationAction =
  | {
      /** 反応不要 */
      readonly kind: 'noop';
    }
  | {
      /** 新規レーン取込と再縮退 */
      readonly kind: 'absorb';
      /** 新規レーン追加分 */
      readonly additions: readonly WorkspaceFolder[];
      /** 再縮退後のフォルダ */
      readonly collapsedFolder: WorkspaceFolder;
    };

/** 照合入力 */
export interface ReconcileInput {
  /** workspaceFolders の現状 */
  readonly rawFolders: readonly WorkspaceFolder[];
  /** カタログ内の既知レーン */
  readonly currentLanes: readonly WorkspaceFolder[];
  /** 現 workspace の新旧 anchor */
  readonly anchor: WorkspaceAnchor;
  /** 活性レーン由来の表示名 */
  readonly activeLabel: string;
  /** symlink folder の URI */
  readonly linkUri: WorkspaceFolder['uri'];
}

/** workspace folder 再整合の結果 */
export type WorkspaceFolderReconciliationResult =
  | {
      /** 変更不要 */
      readonly kind: 'noop';
    }
  | {
      /** catalog 取込と単一 folder への縮退が完了 */
      readonly kind: 'collapsed';
    }
  | {
      /** catalog 取込後に workspace folder の更新が拒否された */
      readonly kind: 'rejected';
    };

/** workspace folder 再整合の依存 */
export interface WorkspaceFolderReconcilerDeps {
  /** runtime 共通 queue */
  readonly operationQueue: OperationQueue;
  /** workspace folder 操作 */
  readonly workspaceHost: WorkspaceHostPort;
  /** 現 catalog folder の取得 */
  readonly getCurrentLanes: () => readonly WorkspaceFolder[];
  /** 現 active label の取得 */
  readonly getActiveLabel: () => string;
  /** catalog への追加取込 */
  readonly absorb: (additions: readonly WorkspaceFolder[]) => Promise<void>;
  /** commit 後に残った lane operation の確定 */
  readonly finalizePendingOperations: () => Promise<void>;
  /** 現 workspace の新旧 anchor */
  readonly anchor: WorkspaceAnchor;
  /** active link URI */
  readonly linkUri: WorkspaceFolder['uri'];
}

/** workspace folder 再整合 */
export interface WorkspaceFolderReconciler {
  /**
   * workspace folder 変更の catalog 取込と縮退
   * @returns 再整合結果
   */
  readonly reconcileWorkspaceFolders: () => Promise<WorkspaceFolderReconciliationResult>;
}

/**
 * 入力からアクションへの純粋変換
 * @param input - 照合入力
 * @returns 応答アクション
 */
export const reconcileUserChange = (input: ReconcileInput): ReconciliationAction => {
  const { rawFolders, currentLanes, anchor, activeLabel, linkUri } = input;

  if (
    rawFolders.length === 1 &&
    classifyWorkspaceFolder(rawFolders[0]!, anchor) === 'active-link'
  ) {
    return { kind: 'noop' };
  }

  const nonSystem = rawFolders.filter(
    (folder) => classifyWorkspaceFolder(folder, anchor) === 'lane',
  );
  const known = new Set(currentLanes.map((f) => f.uri));
  const additions = nonSystem.filter((f) => !known.has(f.uri));

  return {
    kind: 'absorb',
    additions,
    collapsedFolder: { uri: linkUri, name: activeLabel },
  };
};

/**
 * workspace folder 再整合の生成
 * @param deps - 再整合の依存
 * @returns runtime 共通 queue 上の再整合 executor
 */
export const createWorkspaceFolderReconciler = (
  deps: WorkspaceFolderReconcilerDeps,
): WorkspaceFolderReconciler => {
  const {
    operationQueue,
    workspaceHost,
    getCurrentLanes,
    getActiveLabel,
    absorb,
    finalizePendingOperations,
    anchor,
    linkUri,
  } = deps;

  return {
    reconcileWorkspaceFolders: () =>
      operationQueue.enqueue(async () => {
        await finalizePendingOperations();
        const rawFolders = workspaceHost.readFolders();
        const action = reconcileUserChange({
          rawFolders,
          currentLanes: getCurrentLanes(),
          anchor,
          activeLabel: getActiveLabel(),
          linkUri,
        });
        if (action.kind === 'noop') return { kind: 'noop' };

        await absorb(action.additions);
        const accepted = await workspaceHost.applyMutation({
          expectedFolders: rawFolders,
          start: 0,
          deleteCount: rawFolders.length,
          folders: [action.collapsedFolder],
        });
        return accepted ? { kind: 'collapsed' } : { kind: 'rejected' };
      }),
  };
};
