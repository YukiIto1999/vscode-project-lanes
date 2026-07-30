import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog, LaneRootAvailability } from './model';
import { planLaneRelocation } from './relocation-plan';

const toUri = (path: string) => `file://${path}` as UriString;

const makeLane = (id: string, path = `/projects/${id}`): Lane => ({
  id: id as LaneId,
  label: id,
  rootUri: toUri(path),
  rootPath: path as AbsolutePath,
});

const makeCatalog = (lanes: readonly Lane[]): LaneCatalog => ({
  lanes,
  byId: new Map(lanes.map((lane) => [lane.id, lane])),
});

describe('planLaneRelocation', () => {
  it('対象が存在しなければ noop / no-target', () => {
    const catalog = makeCatalog([makeLane('web')]);

    expect(
      planLaneRelocation({
        target: undefined,
        replacementUri: toUri('/projects/api'),
        replacementAvailability: 'available',
        catalog,
      }),
    ).toEqual({ kind: 'noop', reason: 'no-target' });
  });

  it('同じ rootPath なら利用不能でも noop / same-root', () => {
    const target = makeLane('web');
    const catalog = makeCatalog([target]);

    expect(
      planLaneRelocation({
        target,
        replacementUri: 'file:///projects/%77eb' as UriString,
        replacementAvailability: 'missing',
        catalog,
      }),
    ).toEqual({ kind: 'noop', reason: 'same-root' });
  });

  it.each(['missing', 'inaccessible'] as const)(
    '置換先が %s なら rejected / replacement-unavailable',
    (replacementAvailability: LaneRootAvailability) => {
      const target = makeLane('web');
      const catalog = makeCatalog([target]);

      expect(
        planLaneRelocation({
          target,
          replacementUri: toUri('/projects/replacement'),
          replacementAvailability,
          catalog,
        }),
      ).toEqual({ kind: 'rejected', reason: 'replacement-unavailable' });
    },
  );

  it('別レーンと変換後の rootPath が重複すれば rejected / duplicate-root', () => {
    const target = makeLane('web');
    const api = makeLane('api');
    const catalog = makeCatalog([target, api]);

    expect(
      planLaneRelocation({
        target,
        replacementUri: 'file:///projects/%61pi' as UriString,
        replacementAvailability: 'available',
        catalog,
      }),
    ).toEqual({ kind: 'rejected', reason: 'duplicate-root' });
  });

  it('利用可能で重複しない置換先なら relocate', () => {
    const target = makeLane('web');
    const catalog = makeCatalog([target, makeLane('api')]);
    const replacementUri = toUri('/moved/web');

    expect(
      planLaneRelocation({
        target,
        replacementUri,
        replacementAvailability: 'available',
        catalog,
      }),
    ).toEqual({
      kind: 'relocate',
      target,
      replacementUri,
      replacementPath: '/moved/web',
    });
  });
});
