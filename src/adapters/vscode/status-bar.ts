import * as vscode from 'vscode';
import type { StatusBarViewModel } from '../../ui/model';

/** ステータスバー表示アダプター */
export interface StatusBarAdapter {
  /**
   * ビューモデルの反映
   * @param vm - 反映対象ビューモデル
   */
  readonly render: (vm: StatusBarViewModel) => void;
  /** 破棄可能なリソース */
  readonly disposable: vscode.Disposable;
}

/**
 * VS Code ステータスバー表示アダプターの生成
 * @returns ステータスバー表示アダプター
 */
export const createStatusBarAdapter = (): StatusBarAdapter => {
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
