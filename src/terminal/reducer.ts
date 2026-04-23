import type { SessionId, TerminalId } from '../foundation/model';
import type { TerminalCommand, TerminalEffect, TerminalState, TerminalTransition } from './model';

/**
 * 空の初期状態の生成
 * @returns 初期状態
 */
export const initialTerminalState = (): TerminalState => ({
  sessions: new Map(),
  lanes: new Map(),
});

/**
 * ターミナル識別子からのセッション識別子逆引き
 * @param state - 探索対象状態
 * @param terminalId - 検索対象ターミナル識別子
 * @returns 該当セッション識別子、または不一致で undefined
 */
export const findSessionByTerminalId = (
  state: TerminalState,
  terminalId: TerminalId,
): SessionId | undefined => {
  for (const [sessionId, record] of state.sessions) {
    if (record.terminalId === terminalId) return sessionId;
  }
  return undefined;
};

/**
 * 純粋状態遷移
 * @param state - 遷移前状態
 * @param command - 遷移コマンド
 * @returns 遷移結果
 */
export const reduceTerminal = (
  state: TerminalState,
  command: TerminalCommand,
): TerminalTransition => {
  switch (command.kind) {
    case 'sessionStarted': {
      const { spec } = command;
      const sessions = new Map(state.sessions);
      sessions.set(spec.id, { spec, alive: true, terminalId: undefined });

      const lanes = new Map(state.lanes);
      const lane = lanes.get(spec.laneId) ?? { sessionIds: [], lastVisibleSessionId: undefined };
      lanes.set(spec.laneId, {
        ...lane,
        sessionIds: [...lane.sessionIds, spec.id],
      });

      return { state: { ...state, sessions, lanes }, effects: [] };
    }

    case 'terminalBound': {
      const { sessionId, terminalId } = command;
      const sessions = new Map(state.sessions);
      const record = sessions.get(sessionId);
      if (!record) return { state, effects: [] };
      sessions.set(sessionId, { ...record, terminalId });
      return { state: { ...state, sessions }, effects: [] };
    }

    case 'terminalClosed': {
      const sessionId = findSessionByTerminalId(state, command.terminalId);
      if (!sessionId) return { state, effects: [] };
      const sessions = new Map(state.sessions);
      const record = sessions.get(sessionId);
      if (!record) return { state, effects: [] };

      sessions.delete(sessionId);
      const lanes = new Map(state.lanes);
      const lane = lanes.get(record.spec.laneId);
      if (lane) {
        lanes.set(record.spec.laneId, {
          ...lane,
          sessionIds: lane.sessionIds.filter((id) => id !== sessionId),
          lastVisibleSessionId:
            lane.lastVisibleSessionId === sessionId ? undefined : lane.lastVisibleSessionId,
        });
      }

      return {
        state: { ...state, sessions, lanes },
        effects: [{ kind: 'killSession', sessionId }],
      };
    }

    case 'sessionExited': {
      const sessions = new Map(state.sessions);
      const record = sessions.get(command.sessionId);
      if (!record) return { state, effects: [] };
      sessions.set(command.sessionId, { ...record, alive: false });
      return { state: { ...state, sessions }, effects: [] };
    }

    case 'laneRevealed': {
      const { laneId, visibleSessionId } = command;
      const lanes = new Map(state.lanes);
      const lane = lanes.get(laneId);
      if (lane) {
        lanes.set(laneId, { ...lane, lastVisibleSessionId: visibleSessionId });
      }
      return { state: { ...state, lanes }, effects: [] };
    }

    case 'laneClosed': {
      const { laneId } = command;
      const lane = state.lanes.get(laneId);
      if (!lane) return { state, effects: [] };

      const sessions = new Map(state.sessions);
      const effects: TerminalEffect[] = [];

      for (const sessionId of lane.sessionIds) {
        const record = sessions.get(sessionId);
        if (record?.terminalId) {
          effects.push({ kind: 'disposeTerminal', terminalId: record.terminalId });
        }
        effects.push({ kind: 'killSession', sessionId });
        sessions.delete(sessionId);
      }

      const lanes = new Map(state.lanes);
      lanes.delete(laneId);

      return { state: { ...state, sessions, lanes }, effects };
    }

    case 'allDisposed': {
      const effects: TerminalEffect[] = [];
      for (const [sessionId] of state.sessions) {
        effects.push({ kind: 'killSession', sessionId });
      }
      return { state: initialTerminalState(), effects };
    }
  }
};
