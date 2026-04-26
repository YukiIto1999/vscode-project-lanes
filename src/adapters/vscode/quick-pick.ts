import * as vscode from 'vscode';
import type { LanePromptPort } from '../../lane/ports';

/**
 * VS Code QuickPick ベースの対話アダプターの生成
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
});
