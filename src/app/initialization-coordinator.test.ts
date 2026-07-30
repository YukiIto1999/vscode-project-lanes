import { describe, expect, it, vi } from 'vitest';
import type { Disposable } from '../foundation/model';
import type { WorkspaceContext } from '../workspace/model';
import {
  createInitializationCoordinator,
  type InitializationClassification,
  type InitializationCoordinatorDeps,
} from './initialization-coordinator';

const workspaceContext = {
  key: 'workspace-key',
  canonicalLanes: [],
} as WorkspaceContext;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createDeps = (
  classification: InitializationClassification = 'managed',
): {
  readonly deps: InitializationCoordinatorDeps;
  readonly inspect: ReturnType<typeof vi.fn<() => InitializationClassification>>;
  readonly initialize: ReturnType<typeof vi.fn>;
  readonly startRuntime: ReturnType<typeof vi.fn>;
  readonly setStatus: ReturnType<typeof vi.fn>;
  readonly reportFailure: ReturnType<typeof vi.fn>;
} => {
  const inspect = vi.fn(() => classification);
  const initialize = vi.fn(async () => ({ kind: 'ready', context: workspaceContext }) as const);
  const startRuntime = vi.fn();
  const setStatus = vi.fn();
  const reportFailure = vi.fn();
  return {
    deps: { inspect, initialize, startRuntime, setStatus, reportFailure },
    inspect,
    initialize,
    startRuntime,
    setStatus,
    reportFailure,
  };
};

describe('createInitializationCoordinator', () => {
  it('manual の未管理 workspace は明示初期化まで待つ', async () => {
    const { deps, inspect, initialize, setStatus } = createDeps('unmanaged');
    const coordinator = createInitializationCoordinator(deps);

    await expect(coordinator.activate('manual', 'unmanaged')).resolves.toEqual({
      kind: 'waiting',
    });

    expect(inspect).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith('unmanaged');
  });

  it('workspace file 非対応時は初期化を無効化する', async () => {
    const { deps, inspect, initialize, setStatus } = createDeps('unsupported');
    const coordinator = createInitializationCoordinator(deps);

    await expect(coordinator.activate('automatic', 'unsupported')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'no-workspace-file',
    });

    expect(inspect).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('unavailable');
  });

  it.each([
    ['manual', 'managed'],
    ['automatic', 'unmanaged'],
  ] as const)('%s の %s workspace を初期化する', async (mode, classification) => {
    const { deps, inspect, initialize, startRuntime, setStatus } = createDeps(classification);
    const coordinator = createInitializationCoordinator(deps);

    await expect(coordinator.activate(mode, classification)).resolves.toEqual({
      kind: 'ready',
      context: workspaceContext,
    });

    expect(inspect).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledOnce();
    expect(startRuntime).toHaveBeenCalledOnce();
    expect(startRuntime).toHaveBeenCalledWith(workspaceContext);
    expect(setStatus.mock.calls).toEqual([['initializing'], ['ready']]);
  });

  it('公開コマンドから manual の未管理 workspace を初期化する', async () => {
    const { deps, inspect, initialize, startRuntime } = createDeps('unmanaged');
    const coordinator = createInitializationCoordinator(deps);
    await coordinator.activate('manual', 'unmanaged');

    await expect(coordinator.ensureReady()).resolves.toEqual({
      kind: 'ready',
      context: workspaceContext,
    });

    expect(inspect).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledOnce();
    expect(startRuntime).toHaveBeenCalledOnce();
  });

  it('同時の初期化要求を一つの処理にまとめる', async () => {
    const pending = deferred<{ readonly kind: 'ready'; readonly context: WorkspaceContext }>();
    const started = deferred<void>();
    const { deps, initialize, startRuntime } = createDeps();
    initialize.mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const coordinator = createInitializationCoordinator(deps);

    const first = coordinator.ensureReady();
    const second = coordinator.ensureReady();
    await started.promise;

    expect(initialize).toHaveBeenCalledOnce();
    expect(startRuntime).not.toHaveBeenCalled();

    pending.resolve({ kind: 'ready', context: workspaceContext });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'ready', context: workspaceContext },
      { kind: 'ready', context: workspaceContext },
    ]);
    expect(startRuntime).toHaveBeenCalledOnce();
  });

  it('disabled 後の再試行で状態確認と初期化をやり直す', async () => {
    const { deps, inspect, initialize, setStatus } = createDeps();
    initialize
      .mockResolvedValueOnce({ kind: 'disabled', reason: 'missing-anchor' })
      .mockResolvedValueOnce({ kind: 'ready', context: workspaceContext });
    const coordinator = createInitializationCoordinator(deps);

    await expect(coordinator.ensureReady()).resolves.toEqual({
      kind: 'recoverable',
      reason: 'missing-anchor',
    });
    await expect(coordinator.ensureReady()).resolves.toEqual({
      kind: 'ready',
      context: workspaceContext,
    });

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(setStatus.mock.calls).toEqual([
      ['initializing'],
      ['recoverable'],
      ['initializing'],
      ['ready'],
    ]);
  });

  it('initialize の失敗を通知し、次の要求で再試行する', async () => {
    const failure = new Error('initialization failed');
    const { deps, inspect, initialize, reportFailure, setStatus } = createDeps();
    initialize
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ kind: 'ready', context: workspaceContext });
    const coordinator = createInitializationCoordinator(deps);

    await expect(coordinator.ensureReady()).resolves.toEqual({ kind: 'recoverable' });
    await expect(coordinator.ensureReady()).resolves.toEqual({
      kind: 'ready',
      context: workspaceContext,
    });

    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledWith('recoverable');
  });

  it('runtime 起動失敗を通知し、再初期化後に一度だけ起動する', async () => {
    const failure = new Error('runtime failed');
    const { deps, initialize, startRuntime, reportFailure } = createDeps();
    startRuntime.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const coordinator = createInitializationCoordinator(deps);

    await expect(coordinator.ensureReady()).resolves.toEqual({ kind: 'recoverable' });
    await expect(coordinator.ensureReady()).resolves.toEqual({
      kind: 'ready',
      context: workspaceContext,
    });
    await coordinator.ensureReady();

    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(startRuntime).toHaveBeenCalledTimes(2);
  });

  it('ready 状態の公開失敗時は起動済み runtime を破棄して再試行する', async () => {
    const firstRuntime: Disposable = { dispose: vi.fn() };
    const secondRuntime: Disposable = { dispose: vi.fn() };
    const { deps, initialize, startRuntime, reportFailure, setStatus } = createDeps();
    startRuntime.mockReturnValueOnce(firstRuntime).mockReturnValueOnce(secondRuntime);
    setStatus
      .mockImplementationOnce(() => undefined)
      .mockRejectedValueOnce(new Error('setContext'));
    const coordinator = createInitializationCoordinator(deps);

    await expect(coordinator.ensureReady()).resolves.toEqual({ kind: 'recoverable' });
    await expect(coordinator.ensureReady()).resolves.toEqual({
      kind: 'ready',
      context: workspaceContext,
    });

    expect(firstRuntime.dispose).toHaveBeenCalledOnce();
    expect(secondRuntime.dispose).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(startRuntime).toHaveBeenCalledTimes(2);
  });

  it('runtime 起動完了まで ready を返さない', async () => {
    const pending = deferred<void>();
    const { deps, startRuntime } = createDeps();
    startRuntime.mockImplementation(() => pending.promise);
    const coordinator = createInitializationCoordinator(deps);
    let completed = false;

    const running = coordinator.ensureReady().then(() => {
      completed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    pending.resolve();
    await running;
    expect(completed).toBe(true);
  });

  it('initialize 中に dispose された場合は runtime を起動しない', async () => {
    const pending = deferred<{ readonly kind: 'ready'; readonly context: WorkspaceContext }>();
    const { deps, initialize, startRuntime } = createDeps();
    initialize.mockImplementation(() => pending.promise);
    const coordinator = createInitializationCoordinator(deps);

    const running = coordinator.ensureReady();
    await Promise.resolve();
    coordinator.dispose();
    pending.resolve({ kind: 'ready', context: workspaceContext });

    await expect(running).resolves.toEqual({ kind: 'recoverable' });
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('dispose 後の initialize 失敗は通知しない', async () => {
    const pending = deferred<{ readonly kind: 'ready'; readonly context: WorkspaceContext }>();
    const started = deferred<void>();
    const failure = new Error('late failure');
    const { deps, initialize, reportFailure, setStatus } = createDeps();
    initialize.mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const coordinator = createInitializationCoordinator(deps);

    const running = coordinator.ensureReady();
    await started.promise;
    const statusCallCount = setStatus.mock.calls.length;
    coordinator.dispose();
    pending.reject(failure);

    await expect(running).resolves.toEqual({ kind: 'recoverable' });
    expect(reportFailure).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledTimes(statusCallCount);
  });

  it('ready 後は runtime を再起動せず、dispose で破棄する', async () => {
    const runtimeDisposable: Disposable = { dispose: vi.fn() };
    const { deps, inspect, initialize, startRuntime } = createDeps();
    startRuntime.mockReturnValue(runtimeDisposable);
    const coordinator = createInitializationCoordinator(deps);

    await coordinator.ensureReady();
    await coordinator.ensureReady();
    coordinator.dispose();
    coordinator.dispose();

    expect(inspect).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledOnce();
    expect(startRuntime).toHaveBeenCalledOnce();
    expect(runtimeDisposable.dispose).toHaveBeenCalledOnce();
  });
});
