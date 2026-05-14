import * as vscode from 'vscode';
import type { LaneTreeItemViewModel, UiSnapshot } from '../../ui/model';

/**
 * ビューモデルから VS Code TreeItem への変換
 * @param vm - 変換元ビューモデル
 * @returns TreeItem
 */
const toTreeItem = (vm: LaneTreeItemViewModel): vscode.TreeItem => {
  const item = new vscode.TreeItem(vm.label);
  item.id = vm.laneId;
  item.description = vm.description;
  item.iconPath = vm.isActive
    ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
    : new vscode.ThemeIcon('circle-outline');
  item.resourceUri = vscode.Uri.parse(vm.resourceUri);
  item.command = {
    command: 'projectLanes.focus',
    title: 'Focus',
    arguments: [vm.laneId],
  };
  return item;
};

/** TreeView 表示アダプター */
export interface TreeViewAdapter {
  /**
   * UI スナップショットの反映
   * @param snapshot - 反映対象スナップショット
   */
  readonly render: (snapshot: UiSnapshot) => void;
  /** 破棄可能なリソース列 */
  readonly disposables: readonly vscode.Disposable[];
}

/**
 * VS Code TreeView 表示アダプターの生成
 * @returns TreeView 表示アダプター
 */
export const createTreeViewAdapter = (): TreeViewAdapter => {
  const refreshEvent = new vscode.EventEmitter<void>();
  const decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();

  let currentSnapshot: UiSnapshot | undefined;

  const treeDataProvider: vscode.TreeDataProvider<LaneTreeItemViewModel> = {
    onDidChangeTreeData: refreshEvent.event,
    getTreeItem: toTreeItem,
    getChildren: () => (currentSnapshot ? [...currentSnapshot.treeItems] : []),
  };

  const treeView = vscode.window.createTreeView('projectLanes', { treeDataProvider });

  const decorationProvider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: decorationEmitter.event,
    provideFileDecoration: (uri) => {
      if (uri.scheme !== 'lane' || !currentSnapshot) return undefined;
      const laneId = uri.path.replace(/^\//, '');
      const decoration = currentSnapshot.decorations.find((d) => d.laneId === laneId);
      if (!decoration) return undefined;
      return {
        badge: decoration.badge,
        color: new vscode.ThemeColor(decoration.colorThemeKey),
        tooltip: decoration.tooltip,
      };
    },
  };

  const decorationDisposable = vscode.window.registerFileDecorationProvider(decorationProvider);

  return {
    render: (snapshot: UiSnapshot) => {
      currentSnapshot = snapshot;
      treeView.badge = snapshot.badge
        ? { value: snapshot.badge.value, tooltip: snapshot.badge.tooltip }
        : undefined;
      refreshEvent.fire();
      decorationEmitter.fire(snapshot.treeItems.map((item) => vscode.Uri.parse(item.resourceUri)));
    },

    disposables: [treeView, refreshEvent, decorationEmitter, decorationDisposable],
  };
};
