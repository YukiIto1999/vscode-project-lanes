import type { LaneId } from '../foundation/model';
import type { LaneAgent, LaneAgentSummary } from './model';

/** エージェント一覧からレーン単位のサマリーへの集約 */
export const summarizeLaneAgents = (agents: readonly LaneAgent[]): readonly LaneAgentSummary[] => {
  const grouped = new Map<LaneId, LaneAgent[]>();
  for (const agent of agents) {
    const group = grouped.get(agent.laneId);
    if (group) {
      group.push(agent);
    } else {
      grouped.set(agent.laneId, [agent]);
    }
  }

  return [...grouped.entries()].map(([laneId, group]) => {
    const activeCount = group.filter((a) => a.activity === 'active').length;
    return {
      laneId,
      totalCount: group.length,
      activeCount,
      idleCount: group.length - activeCount,
    };
  });
};
