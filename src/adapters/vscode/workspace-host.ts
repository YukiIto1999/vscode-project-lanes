import type { FolderMutation, WorkspaceFolder } from '../../workspace/model';
import type { WorkspaceHostPort } from '../../workspace/ports';

/** workspaceFolders 更新実行境界 */
export interface WorkspaceHostRuntime {
  /** 現在の workspaceFolders */
  readonly readFolders: () => readonly WorkspaceFolder[];
  /** 単一更新の実行 */
  readonly update: (mutation: FolderMutation) => Promise<boolean>;
}

/**
 * workspaceFolders の順序付き等価判定
 * @param actual - 現在のフォルダ列
 * @param expected - 変更計画時のフォルダ列
 * @returns URI、name、順序が一致すれば true
 */
const sameFolders = (
  actual: readonly WorkspaceFolder[],
  expected: readonly WorkspaceFolder[],
): boolean =>
  actual.length === expected.length &&
  actual.every(
    (folder, index) => folder.uri === expected[index]!.uri && folder.name === expected[index]!.name,
  );

/**
 * workspaceFolders 更新を直列化するホストの生成
 * @param runtime - 現状取得と単一更新の実行境界
 * @returns workspaceFolders 操作ポート
 */
export const createQueuedWorkspaceHost = (runtime: WorkspaceHostRuntime): WorkspaceHostPort => {
  let queue: Promise<unknown> = Promise.resolve();

  return {
    readFolders: runtime.readFolders,
    applyMutation: (mutation) => {
      const result = queue.then(() => {
        if (!sameFolders(runtime.readFolders(), mutation.expectedFolders)) return false;
        return runtime.update(mutation);
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
};
