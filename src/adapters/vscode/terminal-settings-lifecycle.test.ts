import { describe, expect, it, vi } from 'vitest';
import type { Memento } from 'vscode';
import { createInitializationCoordinator } from '../../app/initialization-coordinator';
import type { WorkspaceContext } from '../../workspace/model';
import { createTerminalSettingsLease } from './terminal-settings';
import {
  cleanupFailedRuntime,
  createTerminalSettingsLifecycle,
  disposeRuntime,
  type TerminalSettingsLifecycle,
} from './terminal-settings-lifecycle';

const PROFILE_TITLE = 'Lane Terminal';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('createTerminalSettingsLifecycle', () => {
  it('activate の Promise を返す前に終了追跡へ登録する', async () => {
    const register = vi.fn();
    const lifecycle = createTerminalSettingsLifecycle({
      lease: {
        activate: async () => {},
        release: async () => {},
      },
      register,
      unregister: vi.fn(),
      reportReleaseFailure: vi.fn(),
    });

    const activation = lifecycle.activate(PROFILE_TITLE);

    expect(register).toHaveBeenCalledWith(lifecycle);
    await activation;
  });

  it('設定反映後の owned state 保存失敗時に元の設定へ戻して登録を解除する', async () => {
    const failure = new Error('owned state write failed');
    let state: unknown = {
      schemaVersion: 1,
      legacyDecision: 'scanned',
      leases: {},
    };
    let stateWriteCount = 0;
    const values = new Map<string, unknown>([['defaultProfile.linux', 'bash']]);
    const memento: Memento = {
      get: <T>() => state as T,
      update: async (_key, value) => {
        stateWriteCount += 1;
        if (
          stateWriteCount === 2 &&
          (value as { leases?: { linux?: { status?: string } } }).leases?.linux?.status === 'owned'
        ) {
          throw failure;
        }
        state = value;
      },
      keys: () => [],
    };
    const lease = createTerminalSettingsLease({
      workspaceState: memento,
      platform: 'linux',
      configuration: {
        inspectWorkspaceValue: (key) => values.get(key),
        updateWorkspaceValue: async (key, value) => {
          if (value === undefined) values.delete(key);
          else values.set(key, value);
        },
      },
      chooseLegacyAction: async () => undefined,
    });
    const registered = new Set<TerminalSettingsLifecycle>();
    const lifecycle = createTerminalSettingsLifecycle({
      lease,
      register: (value) => registered.add(value),
      unregister: (value) => registered.delete(value),
      reportReleaseFailure: vi.fn(),
    });

    await expect(lifecycle.activate(PROFILE_TITLE)).rejects.toBe(failure);

    expect(values.get('defaultProfile.linux')).toBe('bash');
    expect(state).toEqual({
      schemaVersion: 1,
      legacyDecision: 'scanned',
      leases: {},
    });
    expect(registered.size).toBe(0);
  });

  it('activate と cleanup の両方が失敗した場合は双方を AggregateError に保持する', async () => {
    const activationFailure = new Error('activate failed');
    const cleanupFailure = new Error('cleanup failed');
    const lifecycle = createTerminalSettingsLifecycle({
      lease: {
        activate: async () => {
          throw activationFailure;
        },
        release: async () => {
          throw cleanupFailure;
        },
      },
      register: vi.fn(),
      unregister: vi.fn(),
      reportReleaseFailure: vi.fn(),
    });

    const error = await lifecycle.activate(PROFILE_TITLE).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([activationFailure, cleanupFailure]);
  });

  it('dispose 中の release 完了前に再 activate を開始しない', async () => {
    const releasing = deferred();
    const calls: string[] = [];
    let releaseCount = 0;
    const lifecycle = createTerminalSettingsLifecycle({
      lease: {
        activate: async () => {
          calls.push('activate');
        },
        release: async () => {
          calls.push('release');
          releaseCount += 1;
          if (releaseCount === 1) await releasing.promise;
        },
      },
      register: vi.fn(),
      unregister: vi.fn(),
      reportReleaseFailure: vi.fn(),
    });
    await lifecycle.activate(PROFILE_TITLE);

    lifecycle.dispose();
    const retry = lifecycle.activate(PROFILE_TITLE);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['activate', 'release']);

    releasing.resolve();
    await retry;

    expect(calls).toEqual(['activate', 'release', 'activate']);
  });

  it('先行 release の unregister 後に queued retry を終了追跡へ再登録する', async () => {
    const releasing = deferred();
    let releaseCount = 0;
    const registered = new Set<TerminalSettingsLifecycle>();
    const lifecycle = createTerminalSettingsLifecycle({
      lease: {
        activate: async () => {},
        release: async () => {
          releaseCount += 1;
          if (releaseCount === 1) await releasing.promise;
        },
      },
      register: (value) => registered.add(value),
      unregister: (value) => registered.delete(value),
      reportReleaseFailure: vi.fn(),
    });
    await lifecycle.activate(PROFILE_TITLE);

    lifecycle.dispose();
    const retry = lifecycle.activate(PROFILE_TITLE);
    expect(registered.has(lifecycle)).toBe(true);

    releasing.resolve();
    await retry;

    expect(registered.has(lifecycle)).toBe(true);
    await lifecycle.release();
    expect(registered.has(lifecycle)).toBe(false);
  });

  it('ready status 公開失敗後の再試行は旧 runtime の release 完了を待つ', async () => {
    const releasing = deferred();
    const calls: string[] = [];
    let releaseCount = 0;
    const lifecycle = createTerminalSettingsLifecycle({
      lease: {
        activate: async () => {
          calls.push('activate');
        },
        release: async () => {
          calls.push('release');
          releaseCount += 1;
          if (releaseCount === 1) await releasing.promise;
        },
      },
      register: vi.fn(),
      unregister: vi.fn(),
      reportReleaseFailure: vi.fn(),
    });
    const workspaceContext = {
      key: 'workspace:test',
      canonicalLanes: [],
    } as WorkspaceContext;
    let readyStatusCount = 0;
    const coordinator = createInitializationCoordinator({
      inspect: () => 'managed',
      initialize: async () => ({ kind: 'ready', context: workspaceContext }),
      startRuntime: async () => {
        await lifecycle.activate(PROFILE_TITLE);
        return lifecycle;
      },
      setStatus: async (status) => {
        if (status === 'ready') {
          readyStatusCount += 1;
          if (readyStatusCount === 1) throw new Error('ready status failed');
        }
      },
      reportFailure: vi.fn(),
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({ kind: 'recoverable' });
    const retry = coordinator.ensureReady();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['activate', 'release']);

    releasing.resolve();
    await expect(retry).resolves.toEqual({ kind: 'ready', context: workspaceContext });
    expect(calls).toEqual(['activate', 'release', 'activate']);
  });

  it('ready status と runtime dispose の失敗を coordinator の AggregateError に保持する', async () => {
    const statusFailure = new Error('ready status failed');
    const disposeFailure = new Error('runtime dispose failed');
    const reportFailure = vi.fn();
    const workspaceContext = {
      key: 'workspace:test',
      canonicalLanes: [],
    } as WorkspaceContext;
    const coordinator = createInitializationCoordinator({
      inspect: () => 'managed',
      initialize: async () => ({ kind: 'ready', context: workspaceContext }),
      startRuntime: () => ({
        dispose: () => {
          throw disposeFailure;
        },
      }),
      setStatus: async (status) => {
        if (status === 'ready') throw statusFailure;
      },
      reportFailure,
    });

    await expect(coordinator.ensureReady()).resolves.toEqual({ kind: 'recoverable' });

    const reported = reportFailure.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual([statusFailure, disposeFailure]);
  });

  it('dispose の release 失敗を報告し、明示 release で再試行できる', async () => {
    const failure = new Error('release failed');
    const reportReleaseFailure = vi.fn();
    let releaseCount = 0;
    const lifecycle = createTerminalSettingsLifecycle({
      lease: {
        activate: async () => {},
        release: async () => {
          releaseCount += 1;
          if (releaseCount === 1) throw failure;
        },
      },
      register: vi.fn(),
      unregister: vi.fn(),
      reportReleaseFailure,
    });
    await lifecycle.activate(PROFILE_TITLE);

    lifecycle.dispose();
    await Promise.resolve();
    await Promise.resolve();
    await lifecycle.release();

    expect(reportReleaseFailure).toHaveBeenCalledWith(failure);
    expect(releaseCount).toBe(2);
  });
});

describe('runtime cleanup', () => {
  it('resource dispose が失敗しても terminal settings dispose を必ず実行する', () => {
    const resourceFailure = new Error('resource dispose failed');
    const terminalDispose = vi.fn();

    expect(() =>
      disposeRuntime({
        disposeResources: () => {
          throw resourceFailure;
        },
        terminalSettings: {
          activate: vi.fn(),
          release: vi.fn(),
          dispose: terminalDispose,
        },
      }),
    ).toThrow(resourceFailure);
    expect(terminalDispose).toHaveBeenCalledOnce();
  });

  it('resource と terminal settings の同期 dispose 失敗を AggregateError に保持する', () => {
    const resourceFailure = new Error('resource dispose failed');
    const terminalFailure = new Error('terminal dispose failed');

    const error = (() => {
      try {
        disposeRuntime({
          disposeResources: () => {
            throw resourceFailure;
          },
          terminalSettings: {
            activate: vi.fn(),
            release: vi.fn(),
            dispose: () => {
              throw terminalFailure;
            },
          },
        });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([resourceFailure, terminalFailure]);
  });

  it('startup、resource dispose、lease release の失敗を AggregateError に保持する', async () => {
    const startupFailure = new Error('startup failed');
    const resourceFailure = new Error('resource dispose failed');
    const releaseFailure = new Error('release failed');

    const error = await cleanupFailedRuntime(
      {
        disposeResources: () => {
          throw resourceFailure;
        },
        terminalSettings: {
          activate: vi.fn(),
          release: async () => {
            throw releaseFailure;
          },
          dispose: vi.fn(),
        },
      },
      startupFailure,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      startupFailure,
      resourceFailure,
      releaseFailure,
    ]);
  });
});
