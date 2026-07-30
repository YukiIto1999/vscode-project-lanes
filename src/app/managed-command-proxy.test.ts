import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../workspace/model';
import type { InitializationOutcome, InitializationStatus } from './initialization-coordinator';
import { createManagedCommandProxy, type ManagedCommandProxyDeps } from './managed-command-proxy';

type CommandId = 'projectLanes.switchLane';

const workspaceContext = {
  key: 'workspace-key',
  canonicalLanes: [],
} as WorkspaceContext;
const readyOutcome: InitializationOutcome = { kind: 'ready', context: workspaceContext };

const createDeps = (status: InitializationStatus = 'unmanaged') => {
  let currentStatus = status;
  let handler: ((args: readonly unknown[]) => unknown) | undefined;
  const getHandler = vi.fn(() => handler);
  const showUnavailable = vi.fn();
  const confirmInitialization = vi.fn(async () => false);
  const initialize = vi.fn(async () => readyOutcome);
  const deps: ManagedCommandProxyDeps<CommandId> = {
    getHandler,
    getStatus: () => currentStatus,
    showUnavailable,
    confirmInitialization,
    initialize,
  };
  return {
    deps,
    getHandler,
    showUnavailable,
    confirmInitialization,
    initialize,
    setStatus: (next: InitializationStatus) => {
      currentStatus = next;
    },
    setHandler: (next: (args: readonly unknown[]) => unknown) => {
      handler = next;
    },
  };
};

describe('createManagedCommandProxy', () => {
  it('ready handler へ引数をそのまま渡す', async () => {
    const state = createDeps('ready');
    const handler = vi.fn(() => 'done');
    state.setHandler(handler);
    const invoke = createManagedCommandProxy(state.deps);
    const args = ['lane-b', { source: 'tree' }] as const;

    await expect(invoke('projectLanes.switchLane', args)).resolves.toBe('done');

    expect(handler).toHaveBeenCalledWith(args);
    expect(state.initialize).not.toHaveBeenCalled();
  });

  it('unavailable なら workspace file の案内だけを表示する', async () => {
    const state = createDeps('unavailable');
    const invoke = createManagedCommandProxy(state.deps);

    await expect(invoke('projectLanes.switchLane', [])).resolves.toBeUndefined();

    expect(state.showUnavailable).toHaveBeenCalledOnce();
    expect(state.confirmInitialization).not.toHaveBeenCalled();
    expect(state.initialize).not.toHaveBeenCalled();
  });

  it('初期化を拒否した場合は command を実行しない', async () => {
    const state = createDeps('unmanaged');
    const invoke = createManagedCommandProxy(state.deps);

    await expect(invoke('projectLanes.switchLane', [])).resolves.toBeUndefined();

    expect(state.confirmInitialization).toHaveBeenCalledOnce();
    expect(state.initialize).not.toHaveBeenCalled();
  });

  it('初期化成功後に追加された handler を同じ引数で実行する', async () => {
    const state = createDeps('unmanaged');
    const args = ['lane-b'] as const;
    const handler = vi.fn(() => 'switched');
    state.confirmInitialization.mockResolvedValue(true);
    state.initialize.mockImplementation(async () => {
      state.setStatus('ready');
      state.setHandler(handler);
      return readyOutcome;
    });
    const invoke = createManagedCommandProxy(state.deps);

    await expect(invoke('projectLanes.switchLane', args)).resolves.toBe('switched');

    expect(handler).toHaveBeenCalledWith(args);
  });

  it('initializing 中は確認を重ねず進行中の初期化を待つ', async () => {
    const state = createDeps('initializing');
    const handler = vi.fn();
    state.initialize.mockImplementation(async () => {
      state.setHandler(handler);
      return readyOutcome;
    });
    const invoke = createManagedCommandProxy(state.deps);

    await invoke('projectLanes.switchLane', ['lane-b']);

    expect(state.confirmInitialization).not.toHaveBeenCalled();
    expect(state.initialize).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(['lane-b']);
  });
});
