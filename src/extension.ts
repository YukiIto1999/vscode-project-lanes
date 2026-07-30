import * as vscode from 'vscode';
import { bootstrapRuntime, deactivateRuntime } from './app/bootstrap';
import { workspaceWarningMessage } from './app/workspace-warning';

/**
 * 拡張機能の活性化エントリ
 * @param context - VS Code 拡張コンテキスト
 */
export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
  const outcome = await bootstrapRuntime(context);
  if (outcome.kind === 'ready' || outcome.kind === 'waiting') return;
  const { reason } = outcome;
  if (reason === undefined) return;

  const message = workspaceWarningMessage(reason);
  if (message) vscode.window.showWarningMessage(message);
};

/** 拡張機能の非活性化エントリ */
export const deactivate = async (): Promise<void> => {
  await deactivateRuntime();
};
