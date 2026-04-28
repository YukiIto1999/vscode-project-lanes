import { describe, expect, it } from 'vitest';
import type { LaneId, TerminalId } from '../foundation/model';
import {
  ACTIVE_THRESHOLD_MS,
  ECHO_GAP_MS,
  aggregateLaneActivity,
  initialLaneActivityState,
  nextTransitionAt,
  projectLaneActivities,
  projectTerminalActivity,
  reduceLaneActivity,
} from './reducer';
import type { LaneResolverPort } from './ports';

const tid = (s: string): TerminalId => s as TerminalId;
const lid = (s: string): LaneId => s as LaneId;

describe('reduceLaneActivity', () => {
  it('fg-started で fgRunning=true と lastOutputAt=at を記録', () => {
    const state = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      terminalId: tid('t1'),
      at: 1000,
    });
    expect(state.terminals.get(tid('t1'))).toEqual({
      fgRunning: true,
      lastOutputAt: 1000,
      lastInputAt: 0,
    });
  });

  it('fg-ended で fgRunning=false に更新 (lastOutputAt は保持)', () => {
    let s = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      terminalId: tid('t1'),
      at: 1000,
    });
    s = reduceLaneActivity(s, { kind: 'fg-ended', terminalId: tid('t1') });
    expect(s.terminals.get(tid('t1'))).toEqual({
      fgRunning: false,
      lastOutputAt: 1000,
      lastInputAt: 0,
    });
  });

  it('output で lastOutputAt のみ更新', () => {
    let s = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      terminalId: tid('t1'),
      at: 1000,
    });
    s = reduceLaneActivity(s, { kind: 'output', terminalId: tid('t1'), at: 1500 });
    expect(s.terminals.get(tid('t1'))).toEqual({
      fgRunning: true,
      lastOutputAt: 1500,
      lastInputAt: 0,
    });
  });

  it('input で lastInputAt のみ更新', () => {
    let s = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      terminalId: tid('t1'),
      at: 1000,
    });
    s = reduceLaneActivity(s, { kind: 'input', terminalId: tid('t1'), at: 1200 });
    expect(s.terminals.get(tid('t1'))).toEqual({
      fgRunning: true,
      lastOutputAt: 1000,
      lastInputAt: 1200,
    });
  });

  it('forgotten で当該ターミナルを削除', () => {
    let s = reduceLaneActivity(initialLaneActivityState(), {
      kind: 'fg-started',
      terminalId: tid('t1'),
      at: 1000,
    });
    s = reduceLaneActivity(s, { kind: 'forgotten', terminalId: tid('t1') });
    expect(s.terminals.has(tid('t1'))).toBe(false);
  });

  it('入力 state を破壊せず新しい state を返す', () => {
    const before = initialLaneActivityState();
    const after = reduceLaneActivity(before, {
      kind: 'fg-started',
      terminalId: tid('t1'),
      at: 1000,
    });
    expect(before.terminals.size).toBe(0);
    expect(after.terminals.size).toBe(1);
    expect(after).not.toBe(before);
  });
});

describe('projectTerminalActivity', () => {
  it('fgRunning=false なら shell-prompt', () => {
    expect(
      projectTerminalActivity({ fgRunning: false, lastOutputAt: 0, lastInputAt: 0 }, 5000),
    ).toBe('shell-prompt');
  });

  it('fgRunning + 直近出力 + 入力からエコーギャップ以上経過 → agent-working', () => {
    const state = { fgRunning: true, lastOutputAt: 5500, lastInputAt: 5000 };
    expect(projectTerminalActivity(state, 5500)).toBe('agent-working');
  });

  it('fgRunning + 出力が入力直後 (エコーギャップ以内) → agent-waiting', () => {
    const state = { fgRunning: true, lastOutputAt: 5050, lastInputAt: 5000 };
    expect(projectTerminalActivity(state, 5050)).toBe('agent-waiting');
  });

  it('fgRunning + 出力が入力ちょうど ECHO_GAP_MS 後 → agent-waiting (境界は閉じる)', () => {
    const state = {
      fgRunning: true,
      lastOutputAt: 5000 + ECHO_GAP_MS,
      lastInputAt: 5000,
    };
    expect(projectTerminalActivity(state, 5000 + ECHO_GAP_MS)).toBe('agent-waiting');
  });

  it('fgRunning + 直近出力途絶 (ACTIVE_THRESHOLD_MS 超) → agent-waiting', () => {
    const state = { fgRunning: true, lastOutputAt: 1000, lastInputAt: 0 };
    expect(projectTerminalActivity(state, 1000 + ACTIVE_THRESHOLD_MS)).toBe('agent-waiting');
  });

  it('入力が無い (lastInputAt=0) なら出力は常にエージェント由来扱い', () => {
    const state = { fgRunning: true, lastOutputAt: 5000, lastInputAt: 0 };
    expect(projectTerminalActivity(state, 5500)).toBe('agent-working');
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
    resolveLaneByTerminal: (t) => (mapping[t] ? lid(mapping[t]) : undefined),
  });

  it('working / waiting / no-agent を併存させる', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('w'), at: 9500 });
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('q'), at: 1000 });
    const records = projectLaneActivities(
      s,
      fixedResolver({ w: 'L1', q: 'L2' }),
      [lid('L1'), lid('L2'), lid('L3')],
      10000,
    );
    expect(records).toEqual([
      { laneId: lid('L1'), activity: 'agent-working' },
      { laneId: lid('L2'), activity: 'agent-waiting' },
      { laneId: lid('L3'), activity: 'no-agent' },
    ]);
  });

  it('未解決 terminal はレーンに寄与しない', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('orphan'), at: 1000 });
    const records = projectLaneActivities(s, fixedResolver({}), [lid('L1')], 1100);
    expect(records).toEqual([{ laneId: lid('L1'), activity: 'no-agent' }]);
  });

  it('打鍵直後のエコーは working として扱わず waiting に留める', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('a'), at: 1000 });
    s = reduceLaneActivity(s, { kind: 'input', terminalId: tid('a'), at: 5000 });
    s = reduceLaneActivity(s, { kind: 'output', terminalId: tid('a'), at: 5005 });
    const records = projectLaneActivities(s, fixedResolver({ a: 'L1' }), [lid('L1')], 5005);
    expect(records).toEqual([{ laneId: lid('L1'), activity: 'agent-waiting' }]);
  });

  it('入力後 ECHO_GAP_MS 超の出力は working を判定', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('a'), at: 1000 });
    s = reduceLaneActivity(s, { kind: 'input', terminalId: tid('a'), at: 5000 });
    s = reduceLaneActivity(s, {
      kind: 'output',
      terminalId: tid('a'),
      at: 5000 + ECHO_GAP_MS + 1,
    });
    const records = projectLaneActivities(
      s,
      fixedResolver({ a: 'L1' }),
      [lid('L1')],
      5000 + ECHO_GAP_MS + 1,
    );
    expect(records).toEqual([{ laneId: lid('L1'), activity: 'agent-working' }]);
  });

  it('同一レーンに working と waiting があれば working 優先', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('a'), at: 9500 });
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('b'), at: 1000 });
    const records = projectLaneActivities(
      s,
      fixedResolver({ a: 'L1', b: 'L1' }),
      [lid('L1')],
      10000,
    );
    expect(records).toEqual([{ laneId: lid('L1'), activity: 'agent-working' }]);
  });
});

describe('nextTransitionAt', () => {
  it('fg 中の最早 transition を返す', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('a'), at: 1000 });
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('b'), at: 2000 });
    const at = nextTransitionAt(s, 1100);
    expect(at).toBe(1000 + ACTIVE_THRESHOLD_MS);
  });

  it('fg なし状態では undefined', () => {
    const s = initialLaneActivityState();
    expect(nextTransitionAt(s, 1000)).toBeUndefined();
  });

  it('既に閾値超なら除外し次以降を返す', () => {
    let s = initialLaneActivityState();
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('a'), at: 1000 });
    s = reduceLaneActivity(s, { kind: 'fg-started', terminalId: tid('b'), at: 9000 });
    const now = 1000 + ACTIVE_THRESHOLD_MS + 100;
    expect(nextTransitionAt(s, now)).toBe(9000 + ACTIVE_THRESHOLD_MS);
  });
});
