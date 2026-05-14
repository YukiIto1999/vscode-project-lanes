import type { AbsolutePath } from '../foundation/model';
import type { WorkspaceFolder } from './model';
import { isLegacyAnchor, isLinkFolder } from './scanner';

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
  /** symlink 絶対パス */
  readonly linkPath: AbsolutePath;
  /** 活性レーン由来の表示名 */
  readonly activeLabel: string;
  /** symlink folder の URI */
  readonly linkUri: WorkspaceFolder['uri'];
}

/**
 * 入力からアクションへの純粋変換
 * @param input - 照合入力
 * @returns 応答アクション
 */
export const reconcileUserChange = (input: ReconcileInput): ReconciliationAction => {
  const { rawFolders, currentLanes, linkPath, activeLabel, linkUri } = input;

  if (rawFolders.length === 1 && isLinkFolder(rawFolders[0]!, linkPath)) {
    return { kind: 'noop' };
  }

  const nonSystem = rawFolders.filter((f) => !isLinkFolder(f, linkPath) && !isLegacyAnchor(f));
  const known = new Set(currentLanes.map((f) => f.uri));
  const additions = nonSystem.filter((f) => !known.has(f.uri));

  return {
    kind: 'absorb',
    additions,
    collapsedFolder: { uri: linkUri, name: activeLabel },
  };
};
