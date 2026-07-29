import { describe, expect, it } from 'vitest';
import { createAsyncFailureReporter } from './async-failure-reporter';

describe('createAsyncFailureReporter', () => {
  it('通知 reject を別 error として記録し、外へ reject しない', async () => {
    const operationError = new Error('operation failed');
    const notificationError = new Error('notification failed');
    const logs: { readonly message: string; readonly error: unknown }[] = [];
    let notificationCount = 0;
    const report = createAsyncFailureReporter({
      log: (message, error) => logs.push({ message, error }),
      notify: () => {
        notificationCount += 1;
        return Promise.reject(notificationError);
      },
    });

    await expect(report(operationError)).resolves.toBeUndefined();

    expect(notificationCount).toBe(1);
    expect(logs).toEqual([
      { message: 'Project Lanes operation failed.', error: operationError },
      { message: 'Project Lanes error notification failed.', error: notificationError },
    ]);
  });
});
