import { describe, expect, it } from 'vitest';
import { createOperationQueue } from './operation-queue';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('createOperationQueue', () => {
  it('operation を enqueue 順に一つずつ実行する', async () => {
    const queue = createOperationQueue();
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 'first';
    });
    const second = queue.enqueue(async () => {
      events.push('second:start');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    firstGate.resolve();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('先行 operation の reject 後も後続 operation を実行する', async () => {
    const queue = createOperationQueue();
    const failure = new Error('first failed');
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push('first');
      throw failure;
    });
    const second = queue.enqueue(async () => {
      events.push('second');
      return 2;
    });

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['first', 'second']);
  });

  it('各 caller に固有の戻り値と例外を返す', async () => {
    const queue = createOperationQueue();
    const value = { operation: 'value' };
    const failure = { operation: 'failure' };

    const fulfilled = queue.enqueue(async () => value);
    const rejected = queue.enqueue(async () => Promise.reject(failure));

    await expect(fulfilled).resolves.toBe(value);
    await expect(rejected).rejects.toBe(failure);
  });
});
