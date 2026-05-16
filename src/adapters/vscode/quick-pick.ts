import * as vscode from 'vscode';
import type { LanePromptPort } from '../../lane/ports';

/**
 * VS Code QuickPick / InputBox / WarningMessage 経由の対話アダプターの生成
 * @returns ユーザー対話ポート
 */
export const createPromptAdapter = (): LanePromptPort => ({
  pickLane: async (lanes) => {
    const picked = await vscode.window.showQuickPick(
      lanes.map((l) => ({ label: l.label, laneId: l.id })),
      { title: 'Project Lanes', placeHolder: 'Select a lane to focus' },
    );
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
        detail: 'Removes the lane from the workspace catalog. The folder on disk is not changed.',
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
});
