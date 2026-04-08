import { describe, expect, it } from 'vitest';
import type { LaneId, ProcessId } from '../foundation/model';
import type { LaneAgent } from './model';
import { summarizeLaneAgents } from './summarizer';

const makeAgent = (laneId: string, activity: 'idle' | 'active', pid = 1): LaneAgent => ({
  kind: 'claude-code',
  pid: pid as ProcessId,
  laneId: laneId as LaneId,
  activity,
});

describe('summarizeLaneAgents', () => {
  it('空配列なら空サマリー', () => {
    expect(summarizeLaneAgents([])).toEqual([]);
  });

  it('単一レーンの集約', () => {
    const agents = [
      makeAgent('web', 'active', 1),
      makeAgent('web', 'idle', 2),
      makeAgent('web', 'idle', 3),
    ];
    const result = summarizeLaneAgents(agents);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      laneId: 'web',
      totalCount: 3,
      activeCount: 1,
      idleCount: 2,
    });
  });

  it('複数レーンの集約', () => {
    const agents = [
      makeAgent('web', 'active', 1),
      makeAgent('api', 'idle', 2),
      makeAgent('web', 'idle', 3),
    ];
    const result = summarizeLaneAgents(agents);
    expect(result).toHaveLength(2);
    const web = result.find((s) => s.laneId === 'web')!;
    expect(web.totalCount).toBe(2);
    expect(web.activeCount).toBe(1);
    expect(web.idleCount).toBe(1);
    const api = result.find((s) => s.laneId === 'api')!;
    expect(api.totalCount).toBe(1);
    expect(api.idleCount).toBe(1);
  });
});
