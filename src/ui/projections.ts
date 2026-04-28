import type { LaneId, UriString } from '../foundation/model';
import type { LaneActivity, LaneActivityRecord } from '../lane-activity/model';
import type { Lane, LaneServiceSnapshot } from '../lane/model';
import type {
  ActivityBadgeViewModel,
  LaneDecorationViewModel,
  LaneTreeItemViewModel,
  StatusBarViewModel,
  UiSnapshot,
} from './model';

/** 活動状態のレーン別取得 */
const activityOf = (activityMap: ReadonlyMap<LaneId, LaneActivity>, laneId: LaneId): LaneActivity =>
  activityMap.get(laneId) ?? 'no-agent';

/** ツリー項目に出す補助文言 */
const treeDescriptionFor = (activity: LaneActivity): string => {
  switch (activity) {
    case 'agent-working':
      return 'working';
    case 'agent-waiting':
      return 'waiting';
    case 'no-agent':
      return '';
  }
};

/** デコレーションのテーマカラーキー */
const decorationThemeColorFor = (activity: LaneActivity): string | undefined => {
  switch (activity) {
    case 'agent-working':
      return 'charts.green';
    case 'agent-waiting':
      return 'charts.yellow';
    case 'no-agent':
      return undefined;
  }
};

/** デコレーションのツールチップ */
const decorationTooltipFor = (activity: LaneActivity): string => {
  switch (activity) {
    case 'agent-working':
      return 'Agent is working';
    case 'agent-waiting':
      return 'Agent is waiting for input';
    case 'no-agent':
      return '';
  }
};

/**
 * ツリー項目のビューモデル算出
 * @param lanes - レーン列
 * @param activityMap - レーン単位の活動状態マップ
 * @param activeLaneId - 活性レーン識別子
 * @param showIndicator - 活動インジケータ表示有無
 * @returns ツリー項目列
 */
const projectTreeItems = (
  lanes: readonly Lane[],
  activityMap: ReadonlyMap<LaneId, LaneActivity>,
  activeLaneId: LaneId | undefined,
  showIndicator: boolean,
): readonly LaneTreeItemViewModel[] =>
  lanes.map((lane) => ({
    laneId: lane.id,
    label: lane.label,
    description: showIndicator ? treeDescriptionFor(activityOf(activityMap, lane.id)) : '',
    isActive: lane.id === activeLaneId,
    resourceUri: `lane:///${lane.id}` as UriString,
  }));

/**
 * Activity Bar バッジの算出
 * @param activities - レーン活動レコード列
 * @param showIndicator - 活動インジケータ表示有無
 * @returns バッジビューモデル、または無表示で undefined
 */
const projectBadge = (
  activities: readonly LaneActivityRecord[],
  showIndicator: boolean,
): ActivityBadgeViewModel | undefined => {
  if (!showIndicator) return undefined;
  const waitingCount = activities.filter((a) => a.activity === 'agent-waiting').length;
  if (waitingCount === 0) return undefined;
  const noun = waitingCount === 1 ? 'lane is' : 'lanes are';
  return { value: waitingCount, tooltip: `${waitingCount} ${noun} waiting for input` };
};

/**
 * ファイルデコレーション列の算出
 * @param lanes - レーン列
 * @param activityMap - レーン単位の活動状態マップ
 * @param showIndicator - 活動インジケータ表示有無
 * @returns デコレーション列
 */
const projectDecorations = (
  lanes: readonly Lane[],
  activityMap: ReadonlyMap<LaneId, LaneActivity>,
  showIndicator: boolean,
): readonly LaneDecorationViewModel[] => {
  if (!showIndicator) return [];
  return lanes.flatMap((lane) => {
    const activity = activityOf(activityMap, lane.id);
    const colorThemeKey = decorationThemeColorFor(activity);
    if (!colorThemeKey) return [];
    return [
      {
        laneId: lane.id,
        badge: '●',
        colorThemeKey,
        tooltip: decorationTooltipFor(activity),
      },
    ];
  });
};

/** ステータスバー記号と末尾説明 */
const statusIndicatorFor = (
  activity: LaneActivity,
): { readonly suffix: string; readonly tooltip: string } => {
  switch (activity) {
    case 'agent-working':
      return { suffix: ' $(sync~spin)', tooltip: ' (agent working)' };
    case 'agent-waiting':
      return { suffix: ' $(bell)', tooltip: ' (agent waiting for input)' };
    case 'no-agent':
      return { suffix: '', tooltip: '' };
  }
};

/**
 * ステータスバーの算出
 * @param activeLane - 活性レーン
 * @param activeLaneActivity - 活性レーンの活動状態
 * @param showIndicator - 活動インジケータ表示有無
 * @returns ステータスバービューモデル
 */
const projectStatusBar = (
  activeLane: Lane | undefined,
  activeLaneActivity: LaneActivity,
  showIndicator: boolean,
): StatusBarViewModel => {
  if (!activeLane) {
    return { text: '$(layers) No Lane', tooltip: 'Project Lanes: No lane selected' };
  }
  const { suffix, tooltip } = showIndicator
    ? statusIndicatorFor(activeLaneActivity)
    : { suffix: '', tooltip: '' };
  return {
    text: `$(layers) ${activeLane.label}${suffix}`,
    tooltip: `Project Lanes: ${activeLane.label}${tooltip}`,
  };
};

/**
 * ドメインスナップショットから UI スナップショットへの射影
 * @param lane - レーンサービススナップショット
 * @param activities - レーン活動レコード列
 * @param showActivityIndicator - 活動インジケータ表示有無
 * @returns UI スナップショット
 */
export const projectUi = (
  lane: LaneServiceSnapshot,
  activities: readonly LaneActivityRecord[],
  showActivityIndicator: boolean,
): UiSnapshot => {
  const activityMap = new Map(activities.map((a) => [a.laneId, a.activity]));
  const activeLane = lane.activeLaneId ? lane.catalog.byId.get(lane.activeLaneId) : undefined;
  const activeLaneActivity = lane.activeLaneId
    ? activityOf(activityMap, lane.activeLaneId)
    : 'no-agent';

  return {
    treeItems: projectTreeItems(
      lane.catalog.lanes,
      activityMap,
      lane.activeLaneId,
      showActivityIndicator,
    ),
    badge: projectBadge(activities, showActivityIndicator),
    decorations: projectDecorations(lane.catalog.lanes, activityMap, showActivityIndicator),
    statusBar: projectStatusBar(activeLane, activeLaneActivity, showActivityIndicator),
  };
};
