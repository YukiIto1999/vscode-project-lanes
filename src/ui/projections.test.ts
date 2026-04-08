import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { AgentMonitorSnapshot } from '../agent/model';
import type { LaneServiceSnapshot, LaneCatalog, Lane } from '../lane/model';
import { projectUi } from './projections';

const makeLane = (id: string): Lane => ({
  id: id as LaneId,
  label: id,
  rootUri: `file:///projects/${id}` as UriString,
  rootPath: `/projects/${id}` as AbsolutePath,
});

const makeCatalog = (names: string[]): LaneCatalog => {
  const lanes = names.map(makeLane);
  return { lanes, byId: new Map(lanes.map((l) => [l.id, l])) };
};

const emptyAgents: AgentMonitorSnapshot = { agents: [], summaries: [] };

describe('projectUi', () => {
  it('アクティブレーンなしでステータスバー表示', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web', 'api']),
      activeLaneId: undefined,
    };
    const result = projectUi(lane, emptyAgents, true);

    expect(result.statusBar.text).toBe('$(layers) No Lane');
    expect(result.treeItems).toHaveLength(2);
    expect(result.treeItems.every((i) => !i.isActive)).toBe(true);
  });

  it('アクティブレーンのステータスバーとツリー表示', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web', 'api']),
      activeLaneId: 'web' as LaneId,
    };
    const result = projectUi(lane, emptyAgents, true);

    expect(result.statusBar.text).toBe('$(layers) web');
    expect(result.treeItems.find((i) => i.laneId === 'web')!.isActive).toBe(true);
    expect(result.treeItems.find((i) => i.laneId === 'api')!.isActive).toBe(false);
  });

  it('エージェントサマリーの表示', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const agents: AgentMonitorSnapshot = {
      agents: [],
      summaries: [{ laneId: 'web' as LaneId, totalCount: 3, activeCount: 1, idleCount: 2 }],
    };
    const result = projectUi(lane, agents, true);

    expect(result.statusBar.text).toContain('2 idle / 3');
    expect(result.badge).toBeDefined();
    expect(result.badge!.value).toBe(2);
    expect(result.decorations).toHaveLength(1);
    expect(result.decorations[0]!.colorThemeKey).toBe('charts.yellow');
  });

  it('showAgentStatus=false でエージェント情報を非表示', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const agents: AgentMonitorSnapshot = {
      agents: [],
      summaries: [{ laneId: 'web' as LaneId, totalCount: 3, activeCount: 1, idleCount: 2 }],
    };
    const result = projectUi(lane, agents, false);

    expect(result.badge).toBeUndefined();
    expect(result.decorations).toHaveLength(0);
    expect(result.treeItems[0]!.description).toBe('');
  });

  it('全 active のデコレーションは green', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const agents: AgentMonitorSnapshot = {
      agents: [],
      summaries: [{ laneId: 'web' as LaneId, totalCount: 2, activeCount: 2, idleCount: 0 }],
    };
    const result = projectUi(lane, agents, true);

    expect(result.decorations[0]!.colorThemeKey).toBe('charts.green');
    expect(result.badge).toBeUndefined(); // idle が 0 なのでバッジなし
  });
});
