import * as vscode from 'vscode';
import { bootstrapRuntime } from './app/bootstrap';
import { workspaceWarningMessage } from './app/workspace-warning';

/**
 * 拡張機能の活性化エントリ
 * @param context - VS Code 拡張コンテキスト
 */
export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
  const outcome = await bootstrapRuntime(context);
  if (outcome.kind === 'ready') return;

  const message = workspaceWarningMessage(outcome.reason);
  if (message) vscode.window.showWarningMessage(message);
};

/** 拡張機能の非活性化エントリ */
export const deactivate = (): void => {};
