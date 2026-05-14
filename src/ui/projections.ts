import type { LaneId, UriString } from '../foundation/model';
import type { AgentMonitorSnapshot, LaneAgentSummary } from '../agent/model';
import type { Lane, LaneServiceSnapshot } from '../lane/model';
import type {
  ActivityBadgeViewModel,
  LaneDecorationViewModel,
  LaneTreeItemViewModel,
  StatusBarViewModel,
  UiSnapshot,
} from './model';

/**
 * ツリー項目の description 文言生成
 * @param summary - 対象集約
 * @returns description 文言
 */
const formatDescription = (summary: LaneAgentSummary | undefined): string => {
  if (!summary || summary.totalCount === 0) return '';
  return `${summary.idleCount} idle / ${summary.totalCount} agents`;
};

/**
 * ツリー項目のビューモデル算出
 * @param lanes - レーン列
 * @param summaryMap - レーン単位集約のマップ
 * @param activeLaneId - 活性レーン識別子
 * @returns ツリー項目列
 */
const projectTreeItems = (
  lanes: readonly Lane[],
  summaryMap: ReadonlyMap<LaneId, LaneAgentSummary>,
  activeLaneId: LaneId | undefined,
): readonly LaneTreeItemViewModel[] =>
  lanes.map((lane) => ({
    laneId: lane.id,
    label: lane.label,
    description: formatDescription(summaryMap.get(lane.id)),
    isActive: lane.id === activeLaneId,
    resourceUri: `lane:///${lane.id}` as UriString,
  }));

/**
 * Activity Bar バッジの算出
 * @param summaries - レーン単位集約列
 * @returns バッジビューモデル、または無表示で undefined
 */
const projectBadge = (
  summaries: readonly LaneAgentSummary[],
): ActivityBadgeViewModel | undefined => {
  const idle = summaries.reduce((sum, s) => sum + s.idleCount, 0);
  return idle > 0 ? { value: idle, tooltip: `${idle} agents idle` } : undefined;
};

/**
 * ファイルデコレーション列の算出
 * @param lanes - レーン列
 * @param summaryMap - レーン単位集約のマップ
 * @returns デコレーション列
 */
const projectDecorations = (
  lanes: readonly Lane[],
  summaryMap: ReadonlyMap<LaneId, LaneAgentSummary>,
): readonly LaneDecorationViewModel[] =>
  lanes.flatMap((lane) => {
    const s = summaryMap.get(lane.id);
    if (!s || s.totalCount === 0) return [];
    if (s.idleCount > 0) {
      return [
        {
          laneId: lane.id,
          badge: `${s.idleCount}`,
          colorThemeKey: 'charts.yellow',
          tooltip: `${s.idleCount} idle / ${s.totalCount} agents`,
        },
      ];
    }
    return [
      {
        laneId: lane.id,
        badge: `${s.totalCount}`,
        colorThemeKey: 'charts.green',
        tooltip: `${s.totalCount} agents active`,
      },
    ];
  });

/**
 * ステータスバーの算出
 * @param activeLane - 活性レーン
 * @param summary - 活性レーンの集約
 * @returns ステータスバービューモデル
 */
const projectStatusBar = (
  activeLane: Lane | undefined,
  summary: LaneAgentSummary | undefined,
): StatusBarViewModel => {
  if (!activeLane) {
    return { text: '$(layers) No Lane', tooltip: 'Project Lanes: No lane selected' };
  }
  const agentText = summary ? ` [${summary.idleCount} idle / ${summary.totalCount}]` : '';
  const agentTooltip = summary ? ` (${summary.idleCount} idle / ${summary.totalCount} agents)` : '';
  return {
    text: `$(layers) ${activeLane.label}${agentText}`,
    tooltip: `Project Lanes: ${activeLane.label}${agentTooltip}`,
  };
};

/**
 * ドメインスナップショットから UI スナップショットへの射影
 * @param lane - レーンサービススナップショット
 * @param agents - エージェントモニタスナップショット
 * @param showAgentStatus - エージェント情報の表示有無
 * @returns UI スナップショット
 */
export const projectUi = (
  lane: LaneServiceSnapshot,
  agents: AgentMonitorSnapshot,
  showAgentStatus: boolean,
): UiSnapshot => {
  const summaryMap = new Map(agents.summaries.map((s) => [s.laneId, s]));
  const activeLane = lane.activeLaneId ? lane.catalog.byId.get(lane.activeLaneId) : undefined;

  const effectiveSummaryMap = showAgentStatus ? summaryMap : new Map();
  const effectiveSummaries = showAgentStatus ? agents.summaries : [];

  return {
    treeItems: projectTreeItems(lane.catalog.lanes, effectiveSummaryMap, lane.activeLaneId),
    badge: showAgentStatus ? projectBadge(effectiveSummaries) : undefined,
    decorations: projectDecorations(lane.catalog.lanes, effectiveSummaryMap),
    statusBar: projectStatusBar(
      activeLane,
      showAgentStatus ? summaryMap.get(lane.activeLaneId!) : undefined,
    ),
  };
};
