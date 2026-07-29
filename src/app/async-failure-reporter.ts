/** 非同期失敗通知の依存 */
interface AsyncFailureReporterDeps {
  /** error 記録 */
  readonly log: (message: string, error: unknown) => void;
  /** 利用者通知 */
  readonly notify: () => PromiseLike<unknown>;
}

/**
 * 非同期失敗 reporter の生成
 * @param deps - 記録と通知の依存
 * @returns operation error の reporter
 */
export const createAsyncFailureReporter =
  ({ log, notify }: AsyncFailureReporterDeps) =>
  async (error: unknown): Promise<void> => {
    log('Project Lanes operation failed.', error);
    try {
      await notify();
    } catch (notificationError) {
      log('Project Lanes error notification failed.', notificationError);
    }
  };
