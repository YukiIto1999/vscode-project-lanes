import type { LaneId, UriString } from '../foundation/model';

/** ツリー項目のビューモデル */
export interface LaneTreeItemViewModel {
  readonly laneId: LaneId;
  readonly label: string;
  readonly description: string;
  readonly isActive: boolean;
  readonly resourceUri: UriString;
}

/** Activity Bar バッジのビューモデル */
export interface ActivityBadgeViewModel {
  readonly value: number;
  readonly tooltip: string;
}

/** ファイルデコレーションのビューモデル */
export interface LaneDecorationViewModel {
  readonly laneId: LaneId;
  readonly badge: string;
  readonly colorThemeKey: string;
  readonly tooltip: string;
}

/** ステータスバーのビューモデル */
export interface StatusBarViewModel {
  readonly text: string;
  readonly tooltip: string;
}

/** UI 全体のスナップショット */
export interface UiSnapshot {
  readonly treeItems: readonly LaneTreeItemViewModel[];
  readonly badge: ActivityBadgeViewModel | undefined;
  readonly decorations: readonly LaneDecorationViewModel[];
  readonly statusBar: StatusBarViewModel;
}
