import * as vscode from 'vscode';
import { bootstrapRuntime } from './app/bootstrap';

export const activate = (context: vscode.ExtensionContext): void => {
  const runtime = bootstrapRuntime(context);
  if (runtime) return;

  // workspace ファイル未指定やフォルダ未登録はサイレント無効化。
  // .lanes-root 書き込み失敗のみユーザーへ通知。
  const hasWorkspaceFile =
    vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.scheme === 'file';
  const hasFolders = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  if (hasWorkspaceFile && hasFolders) {
    vscode.window.showWarningMessage(
      'Project Lanes: .lanes-root アンカーを作成できませんでした。ワークスペースファイルのディレクトリの書き込み権限を確認してください。',
    );
  }
};

export const deactivate = (): void => {};
