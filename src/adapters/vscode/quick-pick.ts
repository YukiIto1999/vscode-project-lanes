import * as vscode from 'vscode';
import type { LanePromptPort } from '../../lane/ports';

/**
 * VS Code QuickPick / InputBox / WarningMessage を用いた対話アダプターの生成
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
    vscode.window.showWarningMessage(
      '未保存のファイルがあります。保存してから切り替えてください。',
    );
  },

  promptRename: async (current, validate) => {
    const result = await vscode.window.showInputBox({
      title: 'レーン名の変更',
      value: current,
      valueSelection: [0, current.length],
      validateInput: (v) => validate(v),
    });
    return result;
  },

  confirmRemoval: async (lane) => {
    const choice = await vscode.window.showWarningMessage(
      `レーン "${lane.label}" を削除しますか？`,
      {
        modal: true,
        detail: 'ワークスペースのカタログから除外します。ディスク上のフォルダは変更されません。',
      },
      'OK',
    );
    return choice === 'OK';
  },

  warnActiveLaneRemoval: () => {
    vscode.window.showWarningMessage(
      'アクティブレーンは削除できません。先に別のレーンへ切り替えてください。',
    );
  },
});
