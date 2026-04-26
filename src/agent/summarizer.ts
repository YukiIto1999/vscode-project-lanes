import type { LaneId } from '../foundation/model';
import type { LaneAgent, LaneAgentSummary } from './model';

/**
 * エージェント列からレーン単位の集約算出
 * @param agents - 集約対象エージェント列
 * @returns レーン単位の集約列
 */
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
