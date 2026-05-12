import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog } from './model';
import { planLaneRename } from './rename-plan';

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

describe('planLaneRename', () => {
  it('対象が存在しなければ noop / no-target', () => {
    const catalog = makeCatalog(['web']);
    expect(planLaneRename({ targetId: 'missing' as LaneId, newLabel: 'foo', catalog })).toEqual({
      kind: 'noop',
      reason: 'no-target',
    });
  });

  it('trim 後が空文字なら invalid / empty', () => {
    const catalog = makeCatalog(['web']);
    expect(planLaneRename({ targetId: 'web' as LaneId, newLabel: '  ', catalog })).toEqual({
      kind: 'invalid',
      reason: 'empty',
    });
  });

  it('現在の label と同じなら noop / same-name', () => {
    const catalog = makeCatalog(['web']);
    expect(planLaneRename({ targetId: 'web' as LaneId, newLabel: 'web', catalog })).toEqual({
      kind: 'noop',
      reason: 'same-name',
    });
  });

  it('他レーンと重複したら invalid / duplicate', () => {
    const catalog = makeCatalog(['web', 'api']);
    expect(planLaneRename({ targetId: 'web' as LaneId, newLabel: 'api', catalog })).toEqual({
      kind: 'invalid',
      reason: 'duplicate',
    });
  });

  it('正常入力は rename を返す', () => {
    const catalog = makeCatalog(['web', 'api']);
    const result = planLaneRename({
      targetId: 'web' as LaneId,
      newLabel: '  frontend  ',
      catalog,
    });
    expect(result.kind).toBe('rename');
    if (result.kind !== 'rename') throw new Error('unreachable');
    expect(result.from.id).toBe('web');
    expect(result.to.id).toBe('frontend');
    expect(result.to.label).toBe('frontend');
  });
});
