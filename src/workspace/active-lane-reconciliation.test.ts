import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog, LaneRootAvailability } from '../lane/model';
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

const makeAvailability = (
  catalog: LaneCatalog,
  overrides: ReadonlyMap<LaneId, LaneRootAvailability> = new Map(),
): ReadonlyMap<LaneId, LaneRootAvailability> =>
  new Map(catalog.lanes.map((lane) => [lane.id, overrides.get(lane.id) ?? ('available' as const)]));

const makeInput = (
  overrides: Partial<ActiveLaneReconciliationInput> = {},
): ActiveLaneReconciliationInput => {
  const catalog = overrides.catalog ?? makeCatalog([makeLane('web'), makeLane('api')]);
  return {
    catalog,
    linkPath,
    currentLinkTarget: undefined,
    cachedLaneId: undefined,
    availabilityByLaneId: makeAvailability(catalog),
    ...overrides,
  };
};

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

  it('link target の root が missing なら catalog 先頭の available lane へ退避する', () => {
    const missing = makeLane('missing', '/projects/deleted');
    const catalog = makeCatalog([makeLane('web'), missing]);
    const result = planActiveLaneReconciliation(
      makeInput({
        catalog,
        currentLinkTarget: missing.rootPath,
        cachedLaneId: missing.id,
        availabilityByLaneId: makeAvailability(catalog, new Map([[missing.id, 'missing']])),
      }),
    );

    expect(result).toEqual({
      kind: 'activate',
      lane: makeLane('web'),
      linkSwap: {
        linkPath,
        from: missing.rootPath,
        to: '/projects/web',
      },
      selectionUpdate: { laneId: 'web' },
    });
  });

  it('catalog 内の link target が missing なら別の available cache より先頭 lane を選ぶ', () => {
    const missing = makeLane('missing', '/projects/deleted');
    const catalog = makeCatalog([makeLane('web'), makeLane('api'), missing]);
    const result = planActiveLaneReconciliation(
      makeInput({
        catalog,
        currentLinkTarget: missing.rootPath,
        cachedLaneId: 'api' as LaneId,
        availabilityByLaneId: makeAvailability(catalog, new Map([[missing.id, 'missing']])),
      }),
    );

    expect(result).toMatchObject({
      kind: 'activate',
      lane: makeLane('web'),
      selectionUpdate: { laneId: 'web' },
    });
  });

  it('退避時は catalog 先頭が missing なら後続の先頭 available lane を選ぶ', () => {
    const missing = makeLane('missing', '/projects/deleted');
    const catalog = makeCatalog([missing, makeLane('web'), makeLane('api')]);
    const result = planActiveLaneReconciliation(
      makeInput({
        catalog,
        currentLinkTarget: missing.rootPath,
        cachedLaneId: 'api' as LaneId,
        availabilityByLaneId: makeAvailability(catalog, new Map([[missing.id, 'missing']])),
      }),
    );

    expect(result).toMatchObject({
      kind: 'activate',
      lane: makeLane('web'),
      selectionUpdate: { laneId: 'web' },
    });
  });

  it('link が無いとき inaccessible な cache を無視して先頭の available lane を選ぶ', () => {
    const inaccessible = makeLane('api');
    const catalog = makeCatalog([makeLane('web'), inaccessible]);
    const result = planActiveLaneReconciliation(
      makeInput({
        catalog,
        cachedLaneId: inaccessible.id,
        availabilityByLaneId: makeAvailability(
          catalog,
          new Map([[inaccessible.id, 'inaccessible']]),
        ),
      }),
    );

    expect(result).toMatchObject({
      kind: 'activate',
      lane: makeLane('web'),
      selectionUpdate: { laneId: 'web' },
    });
  });

  it('link が catalog 外なら available な preferred lane を stale cache より優先する', () => {
    const catalog = makeCatalog([makeLane('web', '/moved/web'), makeLane('api')]);
    const result = planActiveLaneReconciliation(
      makeInput({
        catalog,
        currentLinkTarget: '/projects/web' as AbsolutePath,
        preferredLaneId: 'web' as LaneId,
        cachedLaneId: 'api' as LaneId,
        availabilityByLaneId: makeAvailability(catalog),
      }),
    );

    expect(result).toEqual({
      kind: 'activate',
      lane: makeLane('web', '/moved/web'),
      linkSwap: {
        linkPath,
        from: '/projects/web',
        to: '/moved/web',
      },
      selectionUpdate: { laneId: 'web' },
    });
  });

  it('利用可能な lane が一件もなければ inactive plan を返す', () => {
    const catalog = makeCatalog([makeLane('web'), makeLane('api')]);
    const result = planActiveLaneReconciliation(
      makeInput({
        catalog,
        currentLinkTarget: '/projects/web' as AbsolutePath,
        cachedLaneId: 'web' as LaneId,
        availabilityByLaneId: new Map([
          ['web' as LaneId, 'missing'],
          ['api' as LaneId, 'inaccessible'],
        ]),
      }),
    );

    expect(result).toEqual({ kind: 'inactive' });
  });
});
