import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { LaneActivity, LaneActivityRecord } from '../lane-activity/model';
import type { Lane, LaneCatalog, LaneRootAvailability, LaneServiceSnapshot } from '../lane/model';
import { projectUi } from './projections';

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

const rec = (laneId: string, activity: LaneActivity): LaneActivityRecord => ({
  laneId: laneId as LaneId,
  activity,
});

const project = (
  lane: LaneServiceSnapshot,
  activities: readonly LaneActivityRecord[],
  showActivityIndicator: boolean,
  overrides: ReadonlyMap<LaneId, LaneRootAvailability> = new Map(),
) =>
  projectUi(
    lane,
    activities,
    showActivityIndicator,
    new Map(
      lane.catalog.lanes.map((item) => [item.id, overrides.get(item.id) ?? ('available' as const)]),
    ),
  );

describe('projectUi', () => {
  it('同名 label の tree item だけ rootPath を description に表示する', () => {
    const lanes = [
      { ...makeCatalog(['web']).lanes[0]!, label: 'same' },
      { ...makeCatalog(['api']).lanes[0]!, label: 'same' },
      makeCatalog(['docs']).lanes[0]!,
    ];
    const lane: LaneServiceSnapshot = {
      catalog: { lanes, byId: new Map(lanes.map((entry) => [entry.id, entry])) },
      activeLaneId: lanes[0]!.id,
    };

    const result = project(lane, [], false);

    expect(result.treeItems.map((item) => item.description)).toEqual([
      '/projects/web',
      '/projects/api',
      '',
    ]);
  });

  it('アクティブレーンなしでステータスバー表示', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web', 'api']),
      activeLaneId: undefined,
    };
    const result = project(lane, [], true);

    expect(result.statusBar.text).toBe('$(layers) No Lane');
    expect(result.treeItems).toHaveLength(2);
    expect(result.treeItems.every((i) => !i.isActive)).toBe(true);
  });

  it('agent-working は緑デコレーションと working 文言', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = project(lane, [rec('web', 'agent-working')], true);

    expect(result.treeItems[0]!.description).toBe('working');
    expect(result.decorations).toHaveLength(1);
    expect(result.decorations[0]!.colorThemeKey).toBe('charts.green');
    expect(result.statusBar.text).toContain('$(sync~spin)');
    expect(result.statusBar.tooltip).toContain('agent working');
  });

  it('agent-waiting は黄デコレーションと waiting 文言、ベル付きステータス', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = project(lane, [rec('web', 'agent-waiting')], true);

    expect(result.treeItems[0]!.description).toBe('waiting');
    expect(result.decorations[0]!.colorThemeKey).toBe('charts.yellow');
    expect(result.statusBar.text).toContain('$(bell)');
    expect(result.statusBar.tooltip).toContain('agent waiting for input');
  });

  it('no-agent はデコレーション無し、description 空、ステータス末尾なし', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = project(lane, [rec('web', 'no-agent')], true);

    expect(result.treeItems[0]!.description).toBe('');
    expect(result.decorations).toHaveLength(0);
    expect(result.statusBar.text).toBe('$(layers) web');
  });

  it('バッジは waiting レーン数のみカウントし working は含めない', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web', 'api', 'cli']),
      activeLaneId: 'web' as LaneId,
    };
    const records = [
      rec('web', 'agent-working'),
      rec('api', 'agent-waiting'),
      rec('cli', 'agent-waiting'),
    ];
    const result = project(lane, records, true);

    expect(result.badge!.value).toBe(2);
    expect(result.badge!.tooltip).toBe('2 lanes are waiting for input');
  });

  it('waiting が無ければ working のみでもバッジ無し', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = project(lane, [rec('web', 'agent-working')], true);
    expect(result.badge).toBeUndefined();
  });

  it('単数形メッセージは "1 lane is waiting for input"', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = project(lane, [rec('web', 'agent-waiting')], true);
    expect(result.badge!.tooltip).toBe('1 lane is waiting for input');
  });

  it('showActivityIndicator=false で活動表示を全て抑止', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = project(lane, [rec('web', 'agent-waiting')], false);

    expect(result.badge).toBeUndefined();
    expect(result.decorations).toHaveLength(0);
    expect(result.treeItems[0]!.description).toBe('');
    expect(result.statusBar.text).toBe('$(layers) web');
  });

  it.each([
    ['missing', 'Folder not found'],
    ['inaccessible', 'Folder unavailable'],
  ] as const)(
    '%s lane は所在状態を表示して Locate Folder action にする',
    (availability, description) => {
      const lane: LaneServiceSnapshot = {
        catalog: makeCatalog(['web', 'api']),
        activeLaneId: 'web' as LaneId,
      };
      const result = project(
        lane,
        [rec('api', 'agent-working')],
        true,
        new Map([['api' as LaneId, availability]]),
      );

      expect(result.treeItems[1]).toMatchObject({
        laneId: 'api',
        availability,
        action: 'locate',
        description,
      });
    },
  );

  it('available lane は activity description と Switch Lane action を維持する', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = project(lane, [rec('web', 'agent-working')], true);

    expect(result.treeItems[0]).toMatchObject({
      availability: 'available',
      action: 'switch',
      description: 'working',
    });
  });
});
