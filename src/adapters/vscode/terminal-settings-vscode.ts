import * as vscode from 'vscode';
import {
  createTerminalSettingsLease,
  type TerminalSettingsLegacyChoice,
  type TerminalSettingsLease,
} from './terminal-settings';

const LEGACY_SETTINGS_WARNING =
  'Project Lanes 0.1.13 may have changed this workspace’s terminal settings. Choose how to handle the matching legacy values.';
const KEEP_SETTINGS_ACTION = 'Keep Current Settings';
const REMOVE_SETTINGS_ACTION = 'Remove Legacy Settings';
const MANAGE_SETTINGS_ACTION = 'Manage Lane Terminal';

/**
 * VS Code API に接続したターミナル設定 lease の生成
 * @param workspaceState - workspace 単位の状態保存先
 * @param platform - 拡張ホストの platform
 * @returns ターミナル設定 lease
 */
export const createTerminalSettingsLeaseAdapter = (
  workspaceState: vscode.Memento,
  platform: NodeJS.Platform,
): TerminalSettingsLease => {
  const configuration = vscode.workspace.getConfiguration('terminal.integrated');
  return createTerminalSettingsLease({
    workspaceState,
    platform,
    configuration: {
      inspectWorkspaceValue: (key) => configuration.inspect(key)?.workspaceValue,
      updateWorkspaceValue: async (key, value) => {
        await configuration.update(key, value, vscode.ConfigurationTarget.Workspace);
      },
    },
    chooseLegacyAction: async (candidates) => {
      const actions = candidates.defaultProfile
        ? ([REMOVE_SETTINGS_ACTION, KEEP_SETTINGS_ACTION, MANAGE_SETTINGS_ACTION] as const)
        : ([REMOVE_SETTINGS_ACTION, KEEP_SETTINGS_ACTION] as const);
      const selected = await vscode.window.showWarningMessage(LEGACY_SETTINGS_WARNING, ...actions);
      const choiceByAction: Readonly<
        Partial<Record<(typeof actions)[number], TerminalSettingsLegacyChoice>>
      > = {
        [KEEP_SETTINGS_ACTION]: 'keep',
        [REMOVE_SETTINGS_ACTION]: 'remove',
        [MANAGE_SETTINGS_ACTION]: 'manage',
      };
      return selected === undefined ? undefined : choiceByAction[selected];
    },
  });
};
