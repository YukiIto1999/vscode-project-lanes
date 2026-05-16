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
 * 設定値の書き込み先スコープ決定
 * @returns Workspace スコープが利用可能ならそれ、なければ Global
 */
const writeTarget = (): vscode.ConfigurationTarget =>
  vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

/**
 * VS Code 設定読み書きアダプターの生成
 * @returns 設定読み書きポート
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

  toggleActivityIndicator: async () => {
    const cfg = vscode.workspace.getConfiguration('projectLanes');
    const current = cfg.get<boolean>('activity.showIndicator', true);
    await cfg.update('activity.showIndicator', !current, writeTarget());
  },
});
