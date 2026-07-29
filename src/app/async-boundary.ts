/**
 * 非同期操作境界の実行
 * @param operation - 実行対象
 * @param report - 失敗通知
 * @returns 操作完了または失敗通知完了の Promise
 */
export const runAsyncBoundary = async (
  operation: () => Promise<void>,
  report: (error: unknown) => void,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    report(error);
  }
};
