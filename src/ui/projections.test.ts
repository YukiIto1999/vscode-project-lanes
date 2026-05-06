import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, UriString } from '../foundation/model';
import type { LaneActivity, LaneActivityRecord } from '../lane-activity/model';
import type { Lane, LaneCatalog, LaneServiceSnapshot } from '../lane/model';
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

describe('projectUi', () => {
  it('アクティブレーンなしでステータスバー表示', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web', 'api']),
      activeLaneId: undefined,
    };
    const result = projectUi(lane, [], true);

    expect(result.statusBar.text).toBe('$(layers) レーン未選択');
    expect(result.treeItems).toHaveLength(2);
    expect(result.treeItems.every((i) => !i.isActive)).toBe(true);
  });

  it('agent-working は緑デコレーションと実行中文言', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = projectUi(lane, [rec('web', 'agent-working')], true);

    expect(result.treeItems[0]!.description).toBe('実行中');
    expect(result.decorations).toHaveLength(1);
    expect(result.decorations[0]!.colorThemeKey).toBe('charts.green');
    expect(result.statusBar.text).toContain('$(sync~spin)');
    expect(result.statusBar.tooltip).toContain('エージェント実行中');
  });

  it('agent-waiting は黄デコレーションと入力待ち文言、ベル付きステータス', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = projectUi(lane, [rec('web', 'agent-waiting')], true);

    expect(result.treeItems[0]!.description).toBe('入力待ち');
    expect(result.decorations[0]!.colorThemeKey).toBe('charts.yellow');
    expect(result.statusBar.text).toContain('$(bell)');
    expect(result.statusBar.tooltip).toContain('エージェント入力待ち');
  });

  it('no-agent はデコレーション無し、description 空、ステータス末尾なし', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = projectUi(lane, [rec('web', 'no-agent')], true);

    expect(result.treeItems[0]!.description).toBe('');
    expect(result.decorations).toHaveLength(0);
    expect(result.statusBar.text).toBe('$(layers) web');
  });

  it('バッジは waiting レーン数のみカウント (working は含めない)', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web', 'api', 'cli']),
      activeLaneId: 'web' as LaneId,
    };
    const records = [
      rec('web', 'agent-working'),
      rec('api', 'agent-waiting'),
      rec('cli', 'agent-waiting'),
    ];
    const result = projectUi(lane, records, true);

    expect(result.badge!.value).toBe(2);
    expect(result.badge!.tooltip).toBe('2 レーンが入力待ち');
  });

  it('waiting が無ければバッジ無し (working のみは通知不要)', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = projectUi(lane, [rec('web', 'agent-working')], true);
    expect(result.badge).toBeUndefined();
  });

  it('単数形メッセージも "N レーンが入力待ち" の同形式', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = projectUi(lane, [rec('web', 'agent-waiting')], true);
    expect(result.badge!.tooltip).toBe('1 レーンが入力待ち');
  });

  it('showActivityIndicator=false で活動表示を全て抑止', () => {
    const lane: LaneServiceSnapshot = {
      catalog: makeCatalog(['web']),
      activeLaneId: 'web' as LaneId,
    };
    const result = projectUi(lane, [rec('web', 'agent-waiting')], false);

    expect(result.badge).toBeUndefined();
    expect(result.decorations).toHaveLength(0);
    expect(result.treeItems[0]!.description).toBe('');
    expect(result.statusBar.text).toBe('$(layers) web');
  });
});
