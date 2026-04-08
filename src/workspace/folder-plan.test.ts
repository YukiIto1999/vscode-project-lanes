import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog } from '../lane/model';
import { planFocusLane, planRevealAll } from './folder-plan';

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

describe('planFocusLane', () => {
  it('index 1 以降を対象レーンのみに置換', () => {
    const lane = makeLane('web');
    const mutation = planFocusLane(3, lane);
    expect(mutation.start).toBe(1);
    expect(mutation.deleteCount).toBe(2);
    expect(mutation.folders).toEqual([{ uri: lane.rootUri, name: 'web' }]);
  });

  it('フォルダ1つ（アンカーのみ）の場合も動作', () => {
    const lane = makeLane('api');
    const mutation = planFocusLane(1, lane);
    expect(mutation.start).toBe(1);
    expect(mutation.deleteCount).toBe(0);
    expect(mutation.folders).toHaveLength(1);
  });
});

describe('planRevealAll', () => {
  it('全レーンを index 1 以降に配置', () => {
    const catalog = makeCatalog(['web', 'api', 'cli']);
    const mutation = planRevealAll(2, catalog);
    expect(mutation.start).toBe(1);
    expect(mutation.deleteCount).toBe(1);
    expect(mutation.folders).toHaveLength(3);
    expect(mutation.folders.map((f) => f.name)).toEqual(['web', 'api', 'cli']);
  });
});
