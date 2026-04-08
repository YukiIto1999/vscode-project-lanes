import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { LaneCatalog } from './model';
import { resolveLaneId } from './catalog';

const makeCatalog = (names: string[]): LaneCatalog => {
  const lanes = names.map((name) => ({
    id: name as LaneId,
    label: name,
    rootUri: `file:///projects/${name}` as UriString,
    rootPath: `/projects/${name}` as AbsolutePath,
  }));
  return { lanes, byId: new Map(lanes.map((l) => [l.id, l])) };
};

describe('resolveLaneId', () => {
  const catalog = makeCatalog(['web', 'api', 'cli']);

  it('ルート直下のパスからレーン ID を解決', () => {
    expect(resolveLaneId('/projects/web' as AbsolutePath, catalog)).toBe('web');
  });

  it('サブディレクトリからレーン ID を解決', () => {
    expect(resolveLaneId('/projects/api/src/main.ts' as AbsolutePath, catalog)).toBe('api');
  });

  it('該当なしなら undefined', () => {
    expect(resolveLaneId('/tmp/other' as AbsolutePath, catalog)).toBeUndefined();
  });

  it('プレフィクス一致だけでは解決しない', () => {
    expect(resolveLaneId('/projects/web-extra' as AbsolutePath, catalog)).toBeUndefined();
  });

  it('空カタログなら undefined', () => {
    const empty = makeCatalog([]);
    expect(resolveLaneId('/projects/web' as AbsolutePath, empty)).toBeUndefined();
  });
});
