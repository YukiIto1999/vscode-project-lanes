import * as vscode from 'vscode';
import type { StatusBarViewModel } from '../../ui/model';

/** ステータスバー表示のアダプター */
export const createStatusBarAdapter = () => {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'projectLanes.focus';

  return {
    render: (vm: StatusBarViewModel) => {
      item.text = vm.text;
      item.tooltip = vm.tooltip;
      item.show();
    },

    disposable: item,
  };
};
