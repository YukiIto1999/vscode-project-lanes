import * as vscode from 'vscode';
import type { LaneId, UriString } from '../../foundation/model';
import type { LanePromptPort } from '../../lane/ports';

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const E2E_RUN_KEY = 'PROJECT_LANES_E2E_RUN';
const E2E_PICK_REPLACEMENT_FOLDER_COMMAND = 'projectLanes.e2e.pickReplacementFolder';

interface PromptAdapterOptions {
  readonly extensionMode?: vscode.ExtensionMode;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

interface LanePickItem extends vscode.QuickPickItem {
  readonly laneId: LaneId;
}

/**
 * VS Code QuickPick / InputBox / WarningMessage 経由の対話アダプターの生成
 * @param options - runtime mode と process environment
 * @returns ユーザー対話ポート
 */
export const createPromptAdapter = ({
  extensionMode = vscode.ExtensionMode.Production,
  environment = process.env,
}: PromptAdapterOptions = {}): LanePromptPort => ({
  pickLane: async (lanes) => {
    const labelCounts = new Map<string, number>();
    for (const lane of lanes) labelCounts.set(lane.label, (labelCounts.get(lane.label) ?? 0) + 1);
    const items: LanePickItem[] = lanes.map((lane) =>
      labelCounts.get(lane.label) === 1
        ? { label: lane.label, laneId: lane.id }
        : { label: lane.label, description: lane.rootPath, laneId: lane.id },
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Project Lanes',
      placeHolder: 'Select a lane to focus',
    });
    return picked?.laneId;
  },

  warnDirtyEditors: () => {
    vscode.window.showWarningMessage('There are unsaved files. Save them before switching lanes.');
  },

  promptRename: async (current, validate) => {
    const result = await vscode.window.showInputBox({
      title: 'Rename Lane',
      value: current,
      valueSelection: [0, current.length],
      validateInput: (v) => validate(v),
    });
    return result;
  },

  confirmRemoval: async (lane) => {
    const choice = await vscode.window.showWarningMessage(
      `Remove lane "${lane.label}"?`,
      {
        modal: true,
        detail: `Folder: ${lane.rootPath}\n\nRemoves the lane from the workspace catalog. The folder on disk is not changed.`,
      },
      'OK',
    );
    return choice === 'OK';
  },

  warnActiveLaneRemoval: () => {
    vscode.window.showWarningMessage(
      'Cannot remove the active lane. Switch to another lane first.',
    );
  },

  pickFoldersToAdd: async (defaultDirectory) => {
    const picked = await vscode.window.showOpenDialog({
      title: 'Add Folder to Workspace',
      openLabel: 'Add Lane',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: vscode.Uri.file(defaultDirectory),
    });
    return (picked ?? []).map((uri) => uri.toString() as UriString);
  },

  pickReplacementFolder: async (defaultDirectory) => {
    const dialogOptions: vscode.OpenDialogOptions = {
      title: 'Locate Lane Folder',
      openLabel: 'Locate Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(defaultDirectory),
    };
    const useE2eDriver =
      extensionMode === vscode.ExtensionMode.Development &&
      Boolean(environment[E2E_PAYLOAD_KEY]) &&
      Boolean(environment[E2E_RUN_KEY]);
    const picked = useE2eDriver
      ? await vscode.commands.executeCommand<vscode.Uri | undefined>(
          E2E_PICK_REPLACEMENT_FOLDER_COMMAND,
          dialogOptions,
        )
      : (await vscode.window.showOpenDialog(dialogOptions))?.[0];
    return picked?.toString() as UriString | undefined;
  },

  warnAddFolderFailed: () => {
    vscode.window.showWarningMessage(
      'Failed to add the folder to the workspace. Please try again.',
    );
  },
});
