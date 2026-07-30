import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog } from '../lane/model';
import {
  type ActiveLaneReconciliationInput,
  planActiveLaneReconciliation,
} from './active-lane-reconciliation';

const linkPath = '/workspace/.lanes-root/active' as AbsolutePath;

const makeLane = (id: string, rootPath = `/projects/${id}`): Lane => ({
  id: id as LaneId,
  label: id,
  rootUri: `file://${rootPath}` as UriString,
  rootPath: rootPath as AbsolutePath,
});

const makeCatalog = (lanes: readonly Lane[]): LaneCatalog => ({
  lanes,
  byId: new Map(lanes.map((lane) => [lane.id, lane])),
});

const makeInput = (
  overrides: Partial<ActiveLaneReconciliationInput> = {},
): ActiveLaneReconciliationInput => ({
  catalog: makeCatalog([makeLane('web'), makeLane('api')]),
  linkPath,
  currentLinkTarget: undefined,
  cachedLaneId: undefined,
  ...overrides,
});

describe('planActiveLaneReconciliation', () => {
  it('valid link target は stale selection cache より優先する', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        currentLinkTarget: '/projects/api' as AbsolutePath,
        cachedLaneId: 'web' as LaneId,
      }),
    );

    expect(result).toEqual({
      kind: 'activate',
      lane: makeLane('api'),
      linkSwap: undefined,
      selectionUpdate: { laneId: 'api' },
    });
  });

  it('valid link target と selection cache が同じなら更新しない', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        currentLinkTarget: '/projects/api' as AbsolutePath,
        cachedLaneId: 'api' as LaneId,
      }),
    );

    expect(result).toEqual({
      kind: 'activate',
      lane: makeLane('api'),
      linkSwap: undefined,
      selectionUpdate: undefined,
    });
  });

  it('catalog 外の link target より valid selection cache を優先する', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        currentLinkTarget: '/projects/unknown' as AbsolutePath,
        cachedLaneId: 'api' as LaneId,
      }),
    );

    expect(result).toEqual({
      kind: 'activate',
      lane: makeLane('api'),
      linkSwap: {
        linkPath,
        from: '/projects/unknown',
        to: '/projects/api',
      },
      selectionUpdate: undefined,
    });
  });

  it('link 未作成なら valid selection cache を選ぶ', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        cachedLaneId: 'api' as LaneId,
      }),
    );

    expect(result).toEqual({
      kind: 'activate',
      lane: makeLane('api'),
      linkSwap: {
        linkPath,
        from: undefined,
        to: '/projects/api',
      },
      selectionUpdate: undefined,
    });
  });

  it('link target と selection cache が無効なら catalog 先頭を選ぶ', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        currentLinkTarget: '/projects/unknown' as AbsolutePath,
        cachedLaneId: 'unknown' as LaneId,
      }),
    );

    expect(result).toEqual({
      kind: 'activate',
      lane: makeLane('web'),
      linkSwap: {
        linkPath,
        from: '/projects/unknown',
        to: '/projects/web',
      },
      selectionUpdate: { laneId: 'web' },
    });
  });

  it('link 未作成かつ selection cache 無しなら catalog 先頭を選ぶ', () => {
    const result = planActiveLaneReconciliation(makeInput());

    expect(result).toEqual({
      kind: 'activate',
      lane: makeLane('web'),
      linkSwap: {
        linkPath,
        from: undefined,
        to: '/projects/web',
      },
      selectionUpdate: { laneId: 'web' },
    });
  });

  it('catalog が空なら副作用のない empty plan を返す', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        catalog: makeCatalog([]),
        currentLinkTarget: '/projects/unknown' as AbsolutePath,
        cachedLaneId: 'unknown' as LaneId,
      }),
    );

    expect(result).toEqual({ kind: 'empty' });
  });

  it('filesystem 上で欠損した root も catalog と link target が一致すれば選ぶ', () => {
    const missing = makeLane('missing', '/projects/deleted');
    const result = planActiveLaneReconciliation(
      makeInput({
        catalog: makeCatalog([makeLane('web'), missing]),
        currentLinkTarget: missing.rootPath,
        cachedLaneId: 'web' as LaneId,
      }),
    );

    expect(result).toEqual({
      kind: 'activate',
      lane: missing,
      linkSwap: undefined,
      selectionUpdate: { laneId: 'missing' },
    });
  });
});
