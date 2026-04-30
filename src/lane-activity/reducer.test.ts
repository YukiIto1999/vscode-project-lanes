import { describe, expect, it } from 'vitest';
import type { Instant, LaneId, SessionId } from '../foundation/model';
import {
  ACTIVE_THRESHOLD_MS,
  ECHO_GAP_MS,
  aggregateLaneActivity,
  equalSessionMap,
  initialLaneActivityState,
  nextTransitionAt,
  projectLaneActivities,
  projectSessionActivity,
  projectSessionMap,
  reduceLaneActivity,
} from './reducer';
import type { LaneResolverPort } from './ports';

const sid = (s: string): SessionId => s as SessionId;
const lid = (s: string): LaneId => s as LaneId;
const at = (n: number): Instant => n as Instant;

describe('reduceLaneActivity', () => {
  it('fg-started で fgRunning=true と lastOutputAt=at を記録', () => {
    const state = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      sessionId: sid('s1'),
      at: at(1000),
    });
    expect(state.sessions.get(sid('s1'))).toEqual({
      fgRunning: true,
      lastOutputAt: 1000,
      lastInputAt: 0,
    });
  });

  it('fg-ended で fgRunning=false に更新 (lastOutputAt は保持)', () => {
    let s = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      sessionId: sid('s1'),
      at: at(1000),
    });
    s = reduceLaneActivity(s, { kind: 'fg-ended', sessionId: sid('s1') });
    expect(s.sessions.get(sid('s1'))).toEqual({
      fgRunning: false,
      lastOutputAt: 1000,
      lastInputAt: 0,
    });
  });

  it('output で lastOutputAt のみ更新', () => {
    let s = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      sessionId: sid('s1'),
      at: at(1000),
    });
    s = reduceLaneActivity(s, { kind: 'output', sessionId: sid('s1'), at: at(1500) });
    expect(s.sessions.get(sid('s1'))).toEqual({
      fgRunning: true,
      lastOutputAt: 1500,
      lastInputAt: 0,
    });
  });

  it('input で lastInputAt のみ更新', () => {
    let s = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      sessionId: sid('s1'),
      at: at(1000),
    });
    s = reduceLaneActivity(s, { kind: 'input', sessionId: sid('s1'), at: at(1200) });
    expect(s.sessions.get(sid('s1'))).toEqual({
      fgRunning: true,
      lastOutputAt: 1000,
      lastInputAt: 1200,
    });
  });

  it('forgotten で当該セッションを削除', () => {
    let s = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      sessionId: sid('s1'),
      at: at(1000),
    });
    s = reduceLaneActivity(s, { kind: 'forgotten', sessionId: sid('s1') });
    expect(s.sessions.has(sid('s1'))).toBe(false);
  });

  it('入力 state を破壊せず新しい state を返す', () => {
    const before = initialLaneActivityState();
    const after = reduceLaneActivity(before, {
      kind: 'fg-started',
      sessionId: sid('s1'),
      at: at(1000),
    });
    expect(before.sessions.size).toBe(0);
    expect(after.sessions.size).toBe(1);
    expect(after).not.toBe(before);
  });
});

describe('projectSessionActivity', () => {
  it('fgRunning=false なら shell-prompt', () => {
    expect(
      projectSessionActivity(
        { fgRunning: false, lastOutputAt: at(0), lastInputAt: at(0) },
        at(5000),
      ),
    ).toBe('shell-prompt');
  });

  it('fgRunning + 直近出力 + 入力からエコーギャップ以上経過 → agent-working', () => {
    const state = { fgRunning: true, lastOutputAt: at(5500), lastInputAt: at(5000) };
    expect(projectSessionActivity(state, at(5500))).toBe('agent-working');
  });

  it('fgRunning + 出力が入力直後 (エコーギャップ以内) → agent-waiting', () => {
    const state = { fgRunning: true, lastOutputAt: at(5050), lastInputAt: at(5000) };
    expect(projectSessionActivity(state, at(5050))).toBe('agent-waiting');
  });

  it('fgRunning + 出力が入力ちょうど ECHO_GAP_MS 後 → agent-waiting (境界は閉じる)', () => {
    const state = {
      fgRunning: true,
      lastOutputAt: at(5000 + ECHO_GAP_MS),
      lastInputAt: at(5000),
    };
    expect(projectSessionActivity(state, at(5000 + ECHO_GAP_MS))).toBe('agent-waiting');
  });

  it('fgRunning + 直近出力途絶 (ACTIVE_THRESHOLD_MS 超) → agent-waiting', () => {
    const state = { fgRunning: true, lastOutputAt: at(1000), lastInputAt: at(0) };
    expect(projectSessionActivity(state, at(1000 + ACTIVE_THRESHOLD_MS))).toBe('agent-waiting');
  });

  it('入力が無い (lastInputAt=0) なら出力は常にエージェント由来扱い', () => {
    const state = { fgRunning: true, lastOutputAt: at(5000), lastInputAt: at(0) };
    expect(projectSessionActivity(state, at(5500))).toBe('agent-working');
  });
});

describe('aggregateLaneActivity', () => {
  it.each([
    [['agent-working', 'agent-waiting', 'shell-prompt'], 'agent-working'],
    [['agent-waiting', 'shell-prompt'], 'agent-waiting'],
    [['shell-prompt', 'shell-prompt'], 'no-agent'],
    [[], 'no-agent'],
  ] as const)('%j → %s', (activities, expected) => {
    expect(aggregateLaneActivity(activities)).toBe(expected);
  });
});

describe('projectLaneActivities', () => {
  const fixedResolver = (mapping: Record<string, string>): LaneResolverPort => ({
    resolveLaneBySession: (s) => (mapping[s] ? lid(mapping[s]) : undefined),
  });

  it('working / waiting / no-agent を併存させる', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('w'), at: at(9500) });
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('q'), at: at(1000) });
    const records = projectLaneActivities(
      s,
      fixedResolver({ w: 'L1', q: 'L2' }),
      [lid('L1'), lid('L2'), lid('L3')],
      at(10000),
    );
    expect(records).toEqual([
      { laneId: lid('L1'), activity: 'agent-working' },
      { laneId: lid('L2'), activity: 'agent-waiting' },
      { laneId: lid('L3'), activity: 'no-agent' },
    ]);
  });

  it('未解決 session はレーンに寄与しない', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('orphan'), at: at(1000) });
    const records = projectLaneActivities(s, fixedResolver({}), [lid('L1')], at(1100));
    expect(records).toEqual([{ laneId: lid('L1'), activity: 'no-agent' }]);
  });

  it('打鍵直後のエコーは working として扱わず waiting に留める', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('a'), at: at(1000) });
    s = reduceLaneActivity(s, { kind: 'input', sessionId: sid('a'), at: at(5000) });
    s = reduceLaneActivity(s, { kind: 'output', sessionId: sid('a'), at: at(5005) });
    const records = projectLaneActivities(s, fixedResolver({ a: 'L1' }), [lid('L1')], at(5005));
    expect(records).toEqual([{ laneId: lid('L1'), activity: 'agent-waiting' }]);
  });

  it('入力後 ECHO_GAP_MS 超の出力は working を判定', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('a'), at: at(1000) });
    s = reduceLaneActivity(s, { kind: 'input', sessionId: sid('a'), at: at(5000) });
    s = reduceLaneActivity(s, {
      kind: 'output',
      sessionId: sid('a'),
      at: at(5000 + ECHO_GAP_MS + 1),
    });
    const records = projectLaneActivities(
      s,
      fixedResolver({ a: 'L1' }),
      [lid('L1')],
      at(5000 + ECHO_GAP_MS + 1),
    );
    expect(records).toEqual([{ laneId: lid('L1'), activity: 'agent-working' }]);
  });

  it('同一レーンに working と waiting があれば working 優先', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('a'), at: at(9500) });
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('b'), at: at(1000) });
    const records = projectLaneActivities(
      s,
      fixedResolver({ a: 'L1', b: 'L1' }),
      [lid('L1')],
      at(10000),
    );
    expect(records).toEqual([{ laneId: lid('L1'), activity: 'agent-working' }]);
  });
});

describe('projectSessionMap / equalSessionMap', () => {
  it('セッションごとに射影し直接マップを返す', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('a'), at: at(1000) });
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('b'), at: at(9500) });
    const map = projectSessionMap(s, at(10000));
    expect(map.get(sid('a'))).toBe('agent-waiting');
    expect(map.get(sid('b'))).toBe('agent-working');
  });

  it('equalSessionMap はサイズ違いを即不一致と判断', () => {
    const a = new Map([[sid('a'), 'agent-working' as const]]);
    const b = new Map([
      [sid('a'), 'agent-working' as const],
      [sid('b'), 'shell-prompt' as const],
    ]);
    expect(equalSessionMap(a, b)).toBe(false);
  });

  it('equalSessionMap は同サイズ・同内容を等価と判断', () => {
    const a = new Map([
      [sid('a'), 'agent-working' as const],
      [sid('b'), 'agent-waiting' as const],
    ]);
    const b = new Map([
      [sid('b'), 'agent-waiting' as const],
      [sid('a'), 'agent-working' as const],
    ]);
    expect(equalSessionMap(a, b)).toBe(true);
  });
});

describe('nextTransitionAt', () => {
  it('fg 中の最早 transition を返す', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('a'), at: at(1000) });
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('b'), at: at(2000) });
    const t = nextTransitionAt(s, at(1100));
    expect(t).toBe(1000 + ACTIVE_THRESHOLD_MS);
  });

  it('fg なし状態では undefined', () => {
    const s = initialLaneActivityState();
    expect(nextTransitionAt(s, at(1000))).toBeUndefined();
  });

  it('既に閾値超なら除外し次以降を返す', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('a'), at: at(1000) });
    s = reduceLaneActivity(s, { kind: 'fg-started', sessionId: sid('b'), at: at(9000) });
    const now = at(1000 + ACTIVE_THRESHOLD_MS + 100);
    expect(nextTransitionAt(s, now)).toBe(9000 + ACTIVE_THRESHOLD_MS);
  });
});
