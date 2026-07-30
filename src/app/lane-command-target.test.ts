import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { Lane, LaneCatalog } from '../lane/model';
import { resolveLaneCommandTarget } from './lane-command-target';

const lane = (id: string, label: string): Lane => ({
  id: id as LaneId,
  label,
  rootPath: `/repo/${id}` as AbsolutePath,
  rootUri: `file:///repo/${id}` as UriString,
});

const catalog = (...lanes: readonly Lane[]): LaneCatalog => ({
  lanes,
  byId: new Map(lanes.map((entry) => [entry.id, entry])),
});

describe('resolveLaneCommandTarget', () => {
  const web = lane('opaque-web', 'web');
  const api = lane('opaque-api', 'api');

  it('opaque ID を優先して解決する', () => {
    expect(resolveLaneCommandTarget('opaque-web', catalog(web, api))).toBe(web.id);
  });

  it('v0.1.13 以前と E2E の label 引数は一意な場合だけ解決する', () => {
    expect(resolveLaneCommandTarget('api', catalog(web, api))).toBe(api.id);
  });

  it('重複 label は推測しない', () => {
    expect(
      resolveLaneCommandTarget('same', catalog(lane('first', 'same'), lane('second', 'same'))),
    ).toBeUndefined();
  });

  it('TreeItem の laneId field を解決する', () => {
    expect(resolveLaneCommandTarget({ laneId: 'opaque-api' }, catalog(web, api))).toBe(api.id);
  });
});
