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
    cachedSelection: undefined,
    availabilityByLaneId: makeAvailability(catalog),
    ...overrides,
  };
};

describe('planActiveLaneReconciliation', () => {
  it('legacy label より active link を優先し、同じ label でも v2 ID を保存する', () => {
    const web = { ...makeLane('web-id', '/projects/web'), label: 'same' };
    const api = { ...makeLane('api-id', '/projects/api'), label: 'same' };
    const catalog = makeCatalog([web, api]);

    expect(
      planActiveLaneReconciliation(
        makeInput({
          catalog,
          currentLinkTarget: api.rootPath,
          cachedSelection: { kind: 'legacy', label: 'same' },
          availabilityByLaneId: makeAvailability(catalog),
        }),
      ),
    ).toEqual({
      kind: 'activate',
      lane: api,
      linkSwap: undefined,
      selectionUpdate: { laneId: api.id },
    });
  });

  it('link が無ければ一意な legacy label を選び v2 ID へ更新する', () => {
    const web = { ...makeLane('web-id', '/projects/web'), label: 'frontend' };
    const api = { ...makeLane('api-id', '/projects/api'), label: 'backend' };
    const catalog = makeCatalog([web, api]);

    expect(
      planActiveLaneReconciliation(
        makeInput({
          catalog,
          cachedSelection: { kind: 'legacy', label: 'backend' },
          availabilityByLaneId: makeAvailability(catalog),
        }),
      ),
    ).toMatchObject({
      kind: 'activate',
      lane: api,
      selectionUpdate: { laneId: api.id },
    });
  });

  it('legacy label が重複していれば label から推測せず先頭へ fallback する', () => {
    const first = { ...makeLane('first-id', '/projects/first'), label: 'same' };
    const second = { ...makeLane('second-id', '/projects/second'), label: 'same' };
    const catalog = makeCatalog([first, second]);

    expect(
      planActiveLaneReconciliation(
        makeInput({
          catalog,
          cachedSelection: { kind: 'legacy', label: 'same' },
          availabilityByLaneId: makeAvailability(catalog),
        }),
      ),
    ).toMatchObject({
      kind: 'activate',
      lane: first,
      selectionUpdate: { laneId: first.id },
    });
  });

  it('valid link target は stale selection cache より優先する', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        currentLinkTarget: '/projects/api' as AbsolutePath,
        cachedSelection: { kind: 'v2', laneId: 'web' as LaneId },
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
        cachedSelection: { kind: 'v2', laneId: 'api' as LaneId },
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
        cachedSelection: { kind: 'v2', laneId: 'api' as LaneId },
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
        cachedSelection: { kind: 'v2', laneId: 'api' as LaneId },
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

  it('link 未作成時も valid selection cache を旧 link target より優先する', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        legacyLinkTarget: '/projects/api' as AbsolutePath,
        cachedSelection: { kind: 'v2', laneId: 'web' as LaneId },
      }),
    );

    expect(result).toMatchObject({
      kind: 'activate',
      lane: makeLane('web'),
      linkSwap: {
        linkPath,
        from: undefined,
        to: '/projects/web',
      },
    });
  });

  it('link 未作成で cache が無効なら catalog 内の旧 link target を移行候補にする', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        legacyLinkTarget: '/projects/api' as AbsolutePath,
        cachedSelection: { kind: 'v2', laneId: 'unknown' as LaneId },
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
      selectionUpdate: { laneId: 'api' },
    });
  });

  it('新 link が存在すれば旧 link target を移行候補にしない', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        currentLinkTarget: '/projects/unknown' as AbsolutePath,
        legacyLinkTarget: '/projects/api' as AbsolutePath,
      }),
    );

    expect(result).toMatchObject({
      kind: 'activate',
      lane: makeLane('web'),
    });
  });

  it('catalog 外の旧 link target は移行候補にしない', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        legacyLinkTarget: '/projects/unknown' as AbsolutePath,
      }),
    );

    expect(result).toMatchObject({
      kind: 'activate',
      lane: makeLane('web'),
    });
  });

  it('link target と selection cache が無効なら catalog 先頭を選ぶ', () => {
    const result = planActiveLaneReconciliation(
      makeInput({
        currentLinkTarget: '/projects/unknown' as AbsolutePath,
        cachedSelection: { kind: 'v2', laneId: 'unknown' as LaneId },
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
        cachedSelection: { kind: 'v2', laneId: 'unknown' as LaneId },
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
        cachedSelection: { kind: 'v2', laneId: missing.id },
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
        cachedSelection: { kind: 'v2', laneId: 'api' as LaneId },
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
        cachedSelection: { kind: 'v2', laneId: 'api' as LaneId },
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
        cachedSelection: { kind: 'v2', laneId: inaccessible.id },
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
        cachedSelection: { kind: 'v2', laneId: 'api' as LaneId },
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
        cachedSelection: { kind: 'v2', laneId: 'web' as LaneId },
        availabilityByLaneId: new Map([
          ['web' as LaneId, 'missing'],
          ['api' as LaneId, 'inaccessible'],
        ]),
      }),
    );

    expect(result).toEqual({ kind: 'inactive' });
  });
});
