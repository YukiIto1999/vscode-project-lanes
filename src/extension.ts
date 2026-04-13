import * as vscode from 'vscode';
import { bootstrapRuntime } from './app/bootstrap';

export const activate = (context: vscode.ExtensionContext): void => {
  const result = bootstrapRuntime(context);
  if (!result) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showInformationMessage(
        'Project Lanes: ワークスペースにフォルダが追加されていません。マルチルートワークスペースを開いてください。',
      );
    } else {
      vscode.window.showWarningMessage(
        'Project Lanes: .lanes-root アンカーの検出・作成に失敗しました。ワークスペースのルートフォルダ構成を確認してください。',
      );
    }
  }
};

export const deactivate = (): void => {};
