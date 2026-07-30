import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceMutationFailureReporter } from './workspace-mutation-failure-reporter';

interface Deferred {
  readonly promise: Promise<void>;
  readonly reject: (error: unknown) => void;
}

const deferred = (): Deferred => {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
};

describe('createWorkspaceMutationFailureReporter', () => {
  it('通知の dismissal を待たずに report を完了する', async () => {
    const notification = deferred();
    const log = vi.fn();
    const notify = vi.fn(() => notification.promise);
    const report = createWorkspaceMutationFailureReporter({ log, notify });
    const operationError = new Error('mutation rejected');

    await expect(report('Workspace mutation failed.', operationError)).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('Workspace mutation failed.', operationError);
  });

  it('通知の非同期 reject を別 error として記録する', async () => {
    const notification = deferred();
    const log = vi.fn();
    const report = createWorkspaceMutationFailureReporter({
      log,
      notify: () => notification.promise,
    });
    const notificationError = new Error('notification failed');

    await report('Workspace mutation failed.', new Error('mutation rejected'));
    notification.reject(notificationError);
    await Promise.resolve();

    expect(log).toHaveBeenLastCalledWith(
      'Project Lanes workspace warning notification failed.',
      notificationError,
    );
  });
});
