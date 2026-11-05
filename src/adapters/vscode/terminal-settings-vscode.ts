import * as vscode from 'vscode';
import { usesE2eDriver } from './e2e-driver';
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
/** 通知の代わりに E2E driver へ旧版設定の扱いを尋ねるコマンド */
const E2E_CHOOSE_LEGACY_TERMINAL_SETTINGS_COMMAND = 'projectLanes.e2e.chooseLegacyTerminalSettings';

interface TerminalSettingsLeaseAdapterOptions {
  readonly extensionMode?: vscode.ExtensionMode;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * VS Code API に接続したターミナル設定 lease の生成
 * @param workspaceState - workspace 単位の状態保存先
 * @param platform - 拡張ホストの platform
 * @param options - runtime mode と process environment
 * @returns ターミナル設定 lease
 */
export const createTerminalSettingsLeaseAdapter = (
  workspaceState: vscode.Memento,
  platform: NodeJS.Platform,
  {
    extensionMode = vscode.ExtensionMode.Production,
    environment = process.env,
  }: TerminalSettingsLeaseAdapterOptions = {},
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
      // 通知の主操作の自動選択は、同時に表示された別の通知を選び得るため E2E では driver が直接答える
      const selected = usesE2eDriver(extensionMode, environment)
        ? await vscode.commands.executeCommand<(typeof actions)[number] | undefined>(
            E2E_CHOOSE_LEGACY_TERMINAL_SETTINGS_COMMAND,
            { message: LEGACY_SETTINGS_WARNING, actions: [...actions] },
          )
        : await vscode.window.showWarningMessage(LEGACY_SETTINGS_WARNING, ...actions);
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
