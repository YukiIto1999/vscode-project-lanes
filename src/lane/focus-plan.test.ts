import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane } from './model';
import { planLaneFocus } from './focus-plan';

const makeLane = (id: string): Lane => ({
  id: id as LaneId,
  label: id,
  rootUri: `file:///projects/${id}` as UriString,
  rootPath: `/projects/${id}` as AbsolutePath,
});

describe('planLaneFocus', () => {
  it('同一レーンへの切替は noop', () => {
    const lane = makeLane('web');
    expect(planLaneFocus(lane, lane, false)).toEqual({
      kind: 'noop',
      reason: 'same-lane',
    });
  });

  it('ターゲットが未定義なら noop', () => {
    const lane = makeLane('web');
    expect(planLaneFocus(lane, undefined, false)).toEqual({
      kind: 'noop',
      reason: 'no-target',
    });
  });

  it('未保存エディタがあれば blocked', () => {
    const from = makeLane('web');
    const to = makeLane('api');
    expect(planLaneFocus(from, to, true)).toEqual({
      kind: 'blocked',
      reason: 'dirty-editors',
    });
  });

  it('異なるレーンへの切替は focus', () => {
    const from = makeLane('web');
    const to = makeLane('api');
    expect(planLaneFocus(from, to, false)).toEqual({
      kind: 'focus',
      from,
      to,
    });
  });

  it('from が undefined でも focus 可能', () => {
    const to = makeLane('api');
    expect(planLaneFocus(undefined, to, false)).toEqual({
      kind: 'focus',
      from: undefined,
      to,
    });
  });
});
