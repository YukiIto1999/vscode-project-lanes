import { describe, expect, it } from 'vitest';
import type { AbsolutePath, LaneId, SessionId, TerminalId } from '../foundation/model';
import type { TerminalSessionSpec } from './model';
import { findSessionByTerminalId, initialTerminalState, reduceTerminal } from './reducer';

const makeSpec = (id: string, laneId: string): TerminalSessionSpec => ({
  id: id as SessionId,
  laneId: laneId as LaneId,
  title: laneId,
  cwdPath: `/projects/${laneId}` as AbsolutePath,
  shellPath: undefined,
});

describe('reduceTerminal', () => {
  it('sessionStarted でセッション追加', () => {
    const spec = makeSpec('s1', 'web');
    const { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });

    expect(state.sessions.get('s1' as SessionId)).toBeDefined();
    expect(state.sessions.get('s1' as SessionId)!.alive).toBe(true);
    expect(state.lanes.get('web' as LaneId)!.sessionIds).toEqual(['s1']);
  });

  it('terminalBound でターミナル ID 割当', () => {
    const spec = makeSpec('s1', 'web');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    ({ state } = reduceTerminal(state, {
      kind: 'terminalBound',
      sessionId: 's1' as SessionId,
      terminalId: 't1' as TerminalId,
    }));

    expect(state.sessions.get('s1' as SessionId)!.terminalId).toBe('t1');
  });

  it('terminalUnbound でターミナル ID を解除し killSession を発行しない', () => {
    const spec = makeSpec('s1', 'web');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    ({ state } = reduceTerminal(state, {
      kind: 'terminalBound',
      sessionId: 's1' as SessionId,
      terminalId: 't1' as TerminalId,
    }));

    const result = reduceTerminal(state, { kind: 'terminalUnbound', sessionId: 's1' as SessionId });
    expect(result.state.sessions.get('s1' as SessionId)!.terminalId).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it('terminalUnbound 後の terminalClosed は副作用を発行しない', () => {
    const spec = makeSpec('s1', 'web');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    ({ state } = reduceTerminal(state, {
      kind: 'terminalBound',
      sessionId: 's1' as SessionId,
      terminalId: 't1' as TerminalId,
    }));
    ({ state } = reduceTerminal(state, {
      kind: 'terminalUnbound',
      sessionId: 's1' as SessionId,
    }));

    const result = reduceTerminal(state, {
      kind: 'terminalClosed',
      terminalId: 't1' as TerminalId,
    });
    expect(result.effects).toEqual([]);
    expect(result.state.sessions.has('s1' as SessionId)).toBe(true);
  });

  it('terminalClosed でセッション削除と killSession 副作用', () => {
    const spec = makeSpec('s1', 'web');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    ({ state } = reduceTerminal(state, {
      kind: 'terminalBound',
      sessionId: 's1' as SessionId,
      terminalId: 't1' as TerminalId,
    }));

    const result = reduceTerminal(state, {
      kind: 'terminalClosed',
      terminalId: 't1' as TerminalId,
    });
    expect(result.state.sessions.has('s1' as SessionId)).toBe(false);
    expect(result.effects).toContainEqual({ kind: 'killSession', sessionId: 's1' });
  });

  it('sessionExited で alive を false に更新', () => {
    const spec = makeSpec('s1', 'web');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    ({ state } = reduceTerminal(state, { kind: 'sessionExited', sessionId: 's1' as SessionId }));

    expect(state.sessions.get('s1' as SessionId)!.alive).toBe(false);
  });

  it('laneClosed で全セッション削除と副作用生成', () => {
    const s1 = makeSpec('s1', 'web');
    const s2 = makeSpec('s2', 'web');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec: s1 });
    ({ state } = reduceTerminal(state, { kind: 'sessionStarted', spec: s2 }));
    ({ state } = reduceTerminal(state, {
      kind: 'terminalBound',
      sessionId: 's1' as SessionId,
      terminalId: 't1' as TerminalId,
    }));

    const result = reduceTerminal(state, { kind: 'laneClosed', laneId: 'web' as LaneId });
    expect(result.state.sessions.size).toBe(0);
    expect(result.state.lanes.has('web' as LaneId)).toBe(false);
    expect(result.effects).toContainEqual({ kind: 'disposeTerminal', terminalId: 't1' });
    expect(result.effects.filter((e) => e.kind === 'killSession')).toHaveLength(2);
  });

  it('laneRevealed で lastVisibleSessionId を更新', () => {
    const spec = makeSpec('s1', 'web');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    ({ state } = reduceTerminal(state, {
      kind: 'laneRevealed',
      laneId: 'web' as LaneId,
      visibleSessionId: 's1' as SessionId,
    }));

    expect(state.lanes.get('web' as LaneId)!.lastVisibleSessionId).toBe('s1');
  });

  it('allDisposed で全状態クリアと killSession 副作用', () => {
    const s1 = makeSpec('s1', 'web');
    const s2 = makeSpec('s2', 'api');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec: s1 });
    ({ state } = reduceTerminal(state, { kind: 'sessionStarted', spec: s2 }));

    const result = reduceTerminal(state, { kind: 'allDisposed' });
    expect(result.state.sessions.size).toBe(0);
    expect(result.state.lanes.size).toBe(0);
    expect(result.effects.filter((e) => e.kind === 'killSession')).toHaveLength(2);
  });

  it('laneRekeyed で sessions の spec.laneId と lanes Map キーを張替え', () => {
    const s1 = makeSpec('s1', 'web');
    const s2 = makeSpec('s2', 'web');
    const s3 = makeSpec('s3', 'api');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec: s1 });
    ({ state } = reduceTerminal(state, { kind: 'sessionStarted', spec: s2 }));
    ({ state } = reduceTerminal(state, { kind: 'sessionStarted', spec: s3 }));

    const result = reduceTerminal(state, {
      kind: 'laneRekeyed',
      oldLaneId: 'web' as LaneId,
      newLaneId: 'frontend' as LaneId,
    });

    expect(result.state.sessions.get('s1' as SessionId)!.spec.laneId).toBe('frontend');
    expect(result.state.sessions.get('s2' as SessionId)!.spec.laneId).toBe('frontend');
    expect(result.state.sessions.get('s3' as SessionId)!.spec.laneId).toBe('api');
    expect(result.state.lanes.has('web' as LaneId)).toBe(false);
    expect(result.state.lanes.get('frontend' as LaneId)!.sessionIds).toEqual(['s1', 's2']);
    expect(result.effects).toEqual([]);
  });

  it('laneRekeyed で oldLaneId === newLaneId は noop', () => {
    const spec = makeSpec('s1', 'web');
    const { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    const result = reduceTerminal(state, {
      kind: 'laneRekeyed',
      oldLaneId: 'web' as LaneId,
      newLaneId: 'web' as LaneId,
    });
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });

  it('laneRekeyed で対象レーンに記録が無くても他は無傷', () => {
    const spec = makeSpec('s1', 'api');
    const { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    const result = reduceTerminal(state, {
      kind: 'laneRekeyed',
      oldLaneId: 'web' as LaneId,
      newLaneId: 'frontend' as LaneId,
    });
    expect(result.state.sessions.get('s1' as SessionId)!.spec.laneId).toBe('api');
    expect(result.state.lanes.get('api' as LaneId)!.sessionIds).toEqual(['s1']);
    expect(result.state.lanes.has('frontend' as LaneId)).toBe(false);
  });
});

describe('findSessionByTerminalId', () => {
  it('terminalId からセッション ID を逆引き', () => {
    const spec = makeSpec('s1', 'web');
    let { state } = reduceTerminal(initialTerminalState(), { kind: 'sessionStarted', spec });
    ({ state } = reduceTerminal(state, {
      kind: 'terminalBound',
      sessionId: 's1' as SessionId,
      terminalId: 't1' as TerminalId,
    }));

    expect(findSessionByTerminalId(state, 't1' as TerminalId)).toBe('s1');
  });

  it('存在しない terminalId は undefined', () => {
    expect(
      findSessionByTerminalId(initialTerminalState(), 'unknown' as TerminalId),
    ).toBeUndefined();
  });
});
