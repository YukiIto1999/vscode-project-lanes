import * as vscode from 'vscode';
import type { Lane } from '../../lane/model';
import type { LaneSearchResult } from '../../search/model';
import type { SearchUiPort } from '../../search/ports';

/** 検索結果を保持する QuickPick 項目 */
interface ResultItem extends vscode.QuickPickItem {
  readonly result: LaneSearchResult;
}

/** VS Code がテーマアイコンとして描画する `$(name)` / `$(name~modifier)` 構文 */
const ICON_SYNTAX = /\$\([A-Za-z0-9-]+(?:~[A-Za-z]+)?\)/g;

/**
 * ファイル内容やパス中の `$(...)` をアイコンでなく文字として表示させるエスケープ
 * @param text - QuickPick 項目へ表示する文字列
 * @returns アイコン構文を無効化した文字列
 */
export const escapeIconSyntax = (text: string): string => text.replace(ICON_SYNTAX, '\\$&');

/**
 * VS Code QuickPick / InputBox 経由の横断検索対話アダプターの生成
 * @returns 横断検索対話ポート
 */
export const createSearchUiAdapter = (getLanes: () => readonly Lane[]): SearchUiPort => ({
  promptQuery: async () =>
    vscode.window.showInputBox({
      title: 'Find in Lanes',
      placeHolder: 'Search text across all lanes',
    }),

  pickContentResult: async (results, truncated) => {
    const lanes = getLanes();
    const labelCounts = new Map<string, number>();
    for (const lane of lanes) labelCounts.set(lane.label, (labelCounts.get(lane.label) ?? 0) + 1);
    const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
    const grouped = new Map<LaneSearchResult['laneId'], LaneSearchResult[]>();
    for (const result of results) {
      const list = grouped.get(result.laneId) ?? [];
      list.push(result);
      grouped.set(result.laneId, list);
    }
    const items: (ResultItem | vscode.QuickPickItem)[] = [];
    for (const [laneId, list] of grouped) {
      const lane = lanesById.get(laneId);
      const separator: vscode.QuickPickItem =
        lane && labelCounts.get(lane.label) !== 1
          ? {
              label: escapeIconSyntax(lane.label),
              description: escapeIconSyntax(lane.rootPath),
              kind: vscode.QuickPickItemKind.Separator,
            }
          : {
              label: lane ? escapeIconSyntax(lane.label) : 'Unknown lane',
              kind: vscode.QuickPickItemKind.Separator,
            };
      items.push(separator);
      for (const result of list) {
        if (result.kind !== 'content') continue;
        items.push({
          label: escapeIconSyntax(`${result.relativePath}:${result.line}`),
          detail: escapeIconSyntax(result.preview),
          result,
        });
      }
    }
    const picked = (await vscode.window.showQuickPick(items, {
      title: 'Find in Lanes',
      placeHolder: truncated ? 'Showing first 2000 matches' : 'Select a match',
      matchOnDetail: true,
    })) as ResultItem | undefined;
    return picked?.result;
  },

  pickFileResult: async (results) => {
    const lanes = getLanes();
    const labelCounts = new Map<string, number>();
    for (const lane of lanes) labelCounts.set(lane.label, (labelCounts.get(lane.label) ?? 0) + 1);
    const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
    const items: ResultItem[] = [];
    for (const result of results) {
      if (result.kind !== 'file') continue;
      const lane = lanesById.get(result.laneId);
      const description = lane
        ? labelCounts.get(lane.label) === 1
          ? lane.label
          : `${lane.label} — ${lane.rootPath}`
        : 'Unknown lane';
      items.push({
        label: escapeIconSyntax(result.relativePath),
        description: escapeIconSyntax(description),
        result,
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Go to File in Lanes',
      placeHolder: 'Type to filter files across all lanes',
      matchOnDescription: true,
    });
    return picked?.result;
  },

  notifyEmpty: () => {
    vscode.window.showInformationMessage('No results in any lane.');
  },

  warnUnavailable: () => {
    vscode.window.showWarningMessage('Search backend (ripgrep) is unavailable.');
  },
});
