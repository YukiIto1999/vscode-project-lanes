import * as vscode from 'vscode';
import { bootstrapRuntime } from './app/bootstrap';

/**
 * 拡張機能の活性化エントリ
 * @param context - VS Code 拡張コンテキスト
 */
export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
  const outcome = await bootstrapRuntime(context);
  if (outcome.kind === 'ready') return;

  if (outcome.reason === 'missing-anchor') {
    vscode.window.showWarningMessage(
      'Project Lanes: Failed to create the .lanes-root anchor. Check write permission for the workspace file directory.',
    );
  }

  if (outcome.reason === 'workspace-folder-mutation-rejected') {
    vscode.window.showWarningMessage(
      'Project Lanes: VS Code rejected the workspace folder update. Reopen the workspace and try again.',
    );
  }
};

/** 拡張機能の非活性化エントリ */
export const deactivate = (): void => {};
