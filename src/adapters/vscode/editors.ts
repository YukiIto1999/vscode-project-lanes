import * as vscode from 'vscode';
import type { UriString } from '../../foundation/model';
import type { EditorPort } from '../../lane/ports';
import type { EditorSnapshot } from '../../lane/model';
import type { FileOpenPort } from '../../search/ports';

/**
 * VS Code エディタ操作アダプターの生成
 * @returns エディタ操作ポートとファイルオープンポート
 */
export const createEditorAdapter = (): EditorPort & FileOpenPort => ({
  hasDirtyEditors: () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.isDirty)),

  captureSnapshot: (): EditorSnapshot => ({
    tabs: vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs
        .filter(
          (tab): tab is vscode.Tab & { input: vscode.TabInputText } =>
            tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file',
        )
        .map((tab) => ({
          uri: tab.input.uri.toString() as UriString,
          viewColumn: group.viewColumn,
        })),
    ),
  }),

  closeAll: async () => {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    if (tabs.length === 0) return true;
    return vscode.window.tabGroups.close(tabs, true);
  },

  restoreSnapshot: async (snapshot) => {
    for (const tab of snapshot.tabs) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(tab.uri));
        await vscode.window.showTextDocument(doc, tab.viewColumn, true);
      } catch {
        /* 削除済みファイルは無視 */
      }
    }
  },

  openAt: async (path, position) => {
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const options: vscode.TextDocumentShowOptions = position
      ? {
          selection: new vscode.Range(
            position.line - 1,
            position.column - 1,
            position.line - 1,
            position.column - 1,
          ),
        }
      : {};
    await vscode.window.showTextDocument(doc, options);
  },
});
