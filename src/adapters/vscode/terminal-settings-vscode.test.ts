import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Memento } from 'vscode';

const vscodeHarness = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const updates: Array<readonly [string, unknown, unknown]> = [];
  const showWarningMessage = vi.fn();
  const executeCommand = vi.fn();
  return {
    values,
    updates,
    showWarningMessage,
    executeCommand,
    vscode: {
      ConfigurationTarget: { Workspace: 2 },
      ExtensionMode: { Production: 1, Development: 2, Test: 3 },
      commands: { executeCommand },
      workspace: {
        getConfiguration: vi.fn(() => ({
          inspect: (key: string) => ({ workspaceValue: values.get(key) }),
          update: async (key: string, value: unknown, target: unknown) => {
            updates.push([key, value, target]);
            if (value === undefined) values.delete(key);
            else values.set(key, value);
          },
        })),
      },
      window: { showWarningMessage },
    },
  };
});

vi.mock('vscode', () => vscodeHarness.vscode);

import { createTerminalSettingsLeaseAdapter } from './terminal-settings-vscode';

const createMemento = (): Memento => {
  let state: unknown;
  return {
    get: <T>() => state as T,
    update: async (_key, value) => {
      state = value;
    },
    keys: () => [],
  };
};

describe('createTerminalSettingsLeaseAdapter', () => {
  beforeEach(() => {
    vscodeHarness.values.clear();
    vscodeHarness.updates.splice(0);
    vscodeHarness.showWarningMessage.mockReset();
    vscodeHarness.executeCommand.mockReset();
  });

  it('Development の E2E driver 実行では通知を出さず driver コマンドへ同じ選択肢を尋ねる', async () => {
    vscodeHarness.values.set('enablePersistentSessions', false);
    vscodeHarness.executeCommand.mockResolvedValue('Remove Legacy Settings');
    const lease = createTerminalSettingsLeaseAdapter(createMemento(), 'linux', {
      extensionMode: 2,
      environment: { PROJECT_LANES_E2E_PAYLOAD: '{}', PROJECT_LANES_E2E_RUN: '{}' },
    });

    await (
      await lease.activate('Lane Terminal')
    ).legacyDecision;

    expect(vscodeHarness.showWarningMessage).not.toHaveBeenCalled();
    expect(vscodeHarness.executeCommand).toHaveBeenCalledWith(
      'projectLanes.e2e.chooseLegacyTerminalSettings',
      {
        message: expect.stringContaining('Project Lanes 0.1.13'),
        actions: ['Remove Legacy Settings', 'Keep Current Settings'],
      },
    );
    expect(vscodeHarness.values.has('enablePersistentSessions')).toBe(false);
  });

  it('Production では E2E 用の環境変数があっても通知で尋ねる', async () => {
    vscodeHarness.values.set('enablePersistentSessions', false);
    vscodeHarness.showWarningMessage.mockResolvedValue('Keep Current Settings');
    const lease = createTerminalSettingsLeaseAdapter(createMemento(), 'linux', {
      extensionMode: 1,
      environment: { PROJECT_LANES_E2E_PAYLOAD: '{}', PROJECT_LANES_E2E_RUN: '{}' },
    });

    await (
      await lease.activate('Lane Terminal')
    ).legacyDecision;

    expect(vscodeHarness.executeCommand).not.toHaveBeenCalled();
    expect(vscodeHarness.showWarningMessage).toHaveBeenCalledOnce();
  });

  it('legacy default 候補では明示的な3択を表示し、Manage を lease 選択へ変換する', async () => {
    vscodeHarness.values.set('defaultProfile.linux', 'Lane Terminal');
    vscodeHarness.showWarningMessage.mockResolvedValue('Manage Lane Terminal');
    const lease = createTerminalSettingsLeaseAdapter(createMemento(), 'linux');

    await (
      await lease.activate('Lane Terminal')
    ).legacyDecision;

    expect(vscodeHarness.showWarningMessage).toHaveBeenCalledWith(
      'Project Lanes 0.1.13 may have changed this workspace’s terminal settings. Choose how to handle the matching legacy values.',
      'Remove Legacy Settings',
      'Keep Current Settings',
      'Manage Lane Terminal',
    );
    expect(vscodeHarness.updates).toEqual([]);
  });

  it('persistence 候補だけなら管理不能な Manage 選択を表示しない', async () => {
    vscodeHarness.values.set('enablePersistentSessions', false);
    vscodeHarness.showWarningMessage.mockResolvedValue('Keep Current Settings');
    const lease = createTerminalSettingsLeaseAdapter(createMemento(), 'darwin');

    await (
      await lease.activate('Lane Terminal')
    ).legacyDecision;

    expect(vscodeHarness.showWarningMessage).toHaveBeenCalledWith(
      expect.any(String),
      'Remove Legacy Settings',
      'Keep Current Settings',
    );
    expect(vscodeHarness.updates).toEqual([['defaultProfile.osx', 'Lane Terminal', 2]]);
  });

  it('設定更新を Workspace target に限定する', async () => {
    vscodeHarness.showWarningMessage.mockResolvedValue(undefined);
    const memento = createMemento();
    await memento.update('projectLanes.terminalSettings', {
      schemaVersion: 1,
      legacyDecision: 'scanned',
      leases: {},
    });
    vscodeHarness.values.set('defaultProfile.windows', 'PowerShell');
    const lease = createTerminalSettingsLeaseAdapter(memento, 'win32');

    await (
      await lease.activate('Lane Terminal')
    ).legacyDecision;
    await lease.release();

    expect(vscodeHarness.updates).toEqual([
      ['defaultProfile.windows', 'Lane Terminal', 2],
      ['defaultProfile.windows', 'PowerShell', 2],
    ]);
  });
});
