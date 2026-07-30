import { workspaceWarningMessage } from './workspace-warning';

/** workspace mutation 失敗通知の依存 */
export interface WorkspaceMutationFailureReporterDeps {
  /** error 記録 */
  readonly log: (message: string, error: unknown) => void;
  /** 利用者通知 */
  readonly notify: (message: string) => PromiseLike<unknown>;
}

/** workspace mutation 失敗通知 */
export type WorkspaceMutationFailureReporter = (
  logMessage: string,
  error: unknown,
) => Promise<void>;

/**
 * workspace mutation 失敗通知の生成
 * @param deps - 記録と通知の依存
 * @returns dismissal を待たない失敗通知
 */
export const createWorkspaceMutationFailureReporter = (
  deps: WorkspaceMutationFailureReporterDeps,
): WorkspaceMutationFailureReporter => {
  const { log, notify } = deps;

  return (logMessage, error) => {
    log(logMessage, error);
    const message = workspaceWarningMessage('workspace-folder-mutation-rejected');
    if (!message) return Promise.resolve();

    try {
      void Promise.resolve(notify(message)).catch((notificationError: unknown) => {
        log('Project Lanes workspace warning notification failed.', notificationError);
      });
    } catch (notificationError) {
      log('Project Lanes workspace warning notification failed.', notificationError);
    }
    return Promise.resolve();
  };
};
