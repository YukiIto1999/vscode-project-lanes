/**
 * 非同期操作境界の実行
 * @param operation - 実行対象
 * @param report - 完了を待つ失敗通知
 * @returns 操作完了または失敗通知完了の Promise
 */
export const runAsyncBoundary = async (
  operation: () => Promise<void>,
  report: (error: unknown) => void | PromiseLike<void>,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    await report(error);
  }
};
