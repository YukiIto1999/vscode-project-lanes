import * as vscode from 'vscode';
import type { AbsolutePath, Disposable } from '../../foundation/model';
import type { ConfigPort, ProjectLanesConfig } from '../../app/model';

/**
 * 現設定値の取得
 * @returns 現設定値
 */
const readConfig = (): ProjectLanesConfig => {
  const cfg = vscode.workspace.getConfiguration('projectLanes');
  return {
    showActivityIndicator: cfg.get<boolean>('activity.showIndicator', true),
    shellPath: (cfg.get<string>('terminal.shellPath', '') || undefined) as AbsolutePath | undefined,
  };
};

/**
 * VS Code 設定読み取りアダプターの生成
 * @returns 設定読み取りポート
 */
export const createConfigAdapter = (): ConfigPort => ({
  read: readConfig,

  onDidChange: (listener): Disposable => {
    const subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('projectLanes')) {
        listener(readConfig());
      }
    });
    return { dispose: () => subscription.dispose() };
  },
});
