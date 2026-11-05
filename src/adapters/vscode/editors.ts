import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { UriString } from '../../foundation/model';
import type { EditorPort } from '../../lane/ports';
import type { EditorSnapshot } from '../../lane/model';
import type { FileOpenPort } from '../../search/ports';

/**
 * 復元対象ファイルが読取可能な通常ファイルかの判定
 * @param uri - 復元対象タブの URI
 * @returns 読取可能な通常ファイルなら true
 */
const isReadableFile = async (uri: vscode.Uri): Promise<boolean> => {
  try {
    if (!(await stat(uri.fsPath)).isFile()) return false;
    await access(uri.fsPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
};

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
        const uri = vscode.Uri.parse(tab.uri);
        // 開けないファイルも vscode.open はエラー表示のタブとして開くための事前除外
        if (!(await isReadableFile(uri))) continue;
        // openTextDocument の参照保持による active link 配下モデルのレーン切替後の残留回避
        await vscode.commands.executeCommand('vscode.open', uri, {
          viewColumn: tab.viewColumn,
          preserveFocus: true,
          // preview 表示では同一列の後続タブが先行タブを置換するための固定表示
          preview: false,
        } satisfies vscode.TextDocumentShowOptions);
      } catch {
        /* 削除済み・読取不能ファイルは無視 */
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
