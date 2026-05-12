import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog } from './model';
import { planLaneRemoval } from './removal-plan';

const makeLane = (id: string): Lane => ({
  id: id as LaneId,
  label: id,
  rootUri: `file:///projects/${id}` as UriString,
  rootPath: `/projects/${id}` as AbsolutePath,
});

const makeCatalog = (ids: readonly string[]): LaneCatalog => {
  const lanes = ids.map(makeLane);
  return { lanes, byId: new Map(lanes.map((l) => [l.id, l])) };
};

describe('planLaneRemoval', () => {
  it('対象が存在しなければ noop / no-target', () => {
    const catalog = makeCatalog(['web']);
    expect(
      planLaneRemoval({
        targetId: 'missing' as LaneId,
        activeLaneId: 'web' as LaneId,
        catalog,
      }),
    ).toEqual({ kind: 'noop', reason: 'no-target' });
  });

  it('対象がアクティブなら blocked / active-lane', () => {
    const catalog = makeCatalog(['web', 'api']);
    expect(
      planLaneRemoval({
        targetId: 'web' as LaneId,
        activeLaneId: 'web' as LaneId,
        catalog,
      }),
    ).toEqual({ kind: 'blocked', reason: 'active-lane' });
  });

  it('非アクティブなら remove を返す', () => {
    const catalog = makeCatalog(['web', 'api']);
    const result = planLaneRemoval({
      targetId: 'api' as LaneId,
      activeLaneId: 'web' as LaneId,
      catalog,
    });
    expect(result.kind).toBe('remove');
    if (result.kind !== 'remove') throw new Error('unreachable');
    expect(result.target.id).toBe('api');
  });

  it('activeLaneId が undefined でも remove を返す', () => {
    const catalog = makeCatalog(['web']);
    const result = planLaneRemoval({
      targetId: 'web' as LaneId,
      activeLaneId: undefined,
      catalog,
    });
    expect(result.kind).toBe('remove');
  });
});
