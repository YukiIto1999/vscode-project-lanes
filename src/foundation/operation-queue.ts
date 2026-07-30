/** 非同期 operation の直列実行境界 */
export interface OperationQueue {
  /**
   * operation の実行予約
   * @param operation - 直列実行する非同期処理
   * @returns operation 固有の完了 Promise
   */
  readonly enqueue: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * FIFO operation queue の生成
 * @returns operation queue
 */
export const createOperationQueue = (): OperationQueue => {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue: <T>(operation: () => Promise<T>): Promise<T> => {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
};
