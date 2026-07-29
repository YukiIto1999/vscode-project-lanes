import { describe, expect, it, vi } from 'vitest';
import { runAsyncBoundary } from './async-boundary';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('runAsyncBoundary', () => {
  it('operation の完了まで待つ', async () => {
    const pending = deferred();
    let completed = false;

    const running = runAsyncBoundary(
      () => pending.promise,
      () => {},
    ).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    pending.resolve();
    await running;
    expect(completed).toBe(true);
  });

  it('operation の reject を reporter に一度渡して処理済みにする', async () => {
    const failure = new Error('operation failed');
    const report = vi.fn<(error: unknown) => void>();

    await expect(
      runAsyncBoundary(async () => {
        throw failure;
      }, report),
    ).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(failure);
  });

  it('operation の reject 時は async reporter の完了まで待つ', async () => {
    const failure = new Error('operation failed');
    const reporterStarted = deferred();
    const reporterCompletion = deferred();
    let completed = false;
    let reportedError: unknown;

    const running = runAsyncBoundary(
      async () => {
        throw failure;
      },
      async (error) => {
        reportedError = error;
        reporterStarted.resolve();
        await reporterCompletion.promise;
      },
    ).then(() => {
      completed = true;
    });

    await reporterStarted.promise;
    await Promise.resolve();
    expect(completed).toBe(false);

    reporterCompletion.resolve();
    await running;
    expect(reportedError).toBe(failure);
  });
});
