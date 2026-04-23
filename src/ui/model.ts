import type { LaneId, UriString } from '../foundation/model';

/** ツリー項目のビューモデル */
export interface LaneTreeItemViewModel {
  /** レーン識別子 */
  readonly laneId: LaneId;
  /** 表示ラベル */
  readonly label: string;
  /** 補助説明 */
  readonly description: string;
  /** 活性レーン判定 */
  readonly isActive: boolean;
  /** リソース URI */
  readonly resourceUri: UriString;
}

/** Activity Bar バッジのビューモデル */
export interface ActivityBadgeViewModel {
  /** バッジ値 */
  readonly value: number;
  /** ツールチップ */
  readonly tooltip: string;
}

/** ファイルデコレーションのビューモデル */
export interface LaneDecorationViewModel {
  /** レーン識別子 */
  readonly laneId: LaneId;
  /** バッジ表記 */
  readonly badge: string;
  /** テーマカラーキー */
  readonly colorThemeKey: string;
  /** ツールチップ */
  readonly tooltip: string;
}

/** ステータスバーのビューモデル */
export interface StatusBarViewModel {
  /** 表示テキスト */
  readonly text: string;
  /** ツールチップ */
  readonly tooltip: string;
}

/** UI 全体のスナップショット */
export interface UiSnapshot {
  /** ツリー項目列 */
  readonly treeItems: readonly LaneTreeItemViewModel[];
  /** Activity Bar バッジ */
  readonly badge: ActivityBadgeViewModel | undefined;
  /** ファイルデコレーション列 */
  readonly decorations: readonly LaneDecorationViewModel[];
  /** ステータスバー */
  readonly statusBar: StatusBarViewModel;
}
