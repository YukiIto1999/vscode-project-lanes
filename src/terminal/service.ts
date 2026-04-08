import type { AbsolutePath, Disposable, LaneId, SessionId, TerminalId } from '../foundation/model';
import type { Lane } from '../lane/model';
import type { TerminalCommand, TerminalEffect, TerminalSessionSpec } from './model';
import type {
  SessionIdPort,
  ShellSessionFactoryPort,
  ShellSessionHandle,
  TerminalPresentationPort,
} from './ports';
import { findSessionByTerminalId, initialTerminalState, reduceTerminal } from './reducer';

/** ターミナルサービスの依存 */
export interface TerminalServiceDeps {
  readonly shellFactory: ShellSessionFactoryPort;
  readonly presentation: TerminalPresentationPort;
  readonly sessionId: SessionIdPort;
  readonly getShellPath: () => AbsolutePath | undefined;
}

/** ターミナルサービスの操作インターフェース */
export interface TerminalService {
  /** レーン切替時: 既存ターミナルを dispose し対象レーンのセッションを復元 */
  readonly revealLane: (lane: Lane) => void;
  /** 新規ターミナルを追加（プロファイル +ボタン用） */
  readonly addTerminal: (lane: Lane) => void;
  readonly closeLane: (laneId: LaneId) => void;
  readonly handleTerminalClosed: (terminalId: TerminalId) => void;
  readonly managedSessionIds: () => ReadonlySet<SessionId>;
  readonly dispose: () => void;
}

/** ターミナルサービスの生成 */
export const createTerminalService = (deps: TerminalServiceDeps): TerminalService => {
  const { shellFactory, presentation, sessionId: sessionIdPort } = deps;
  let state = initialTerminalState();
  const handles = new Map<SessionId, ShellSessionHandle>();
  const exitDisposables = new Map<SessionId, Disposable>();

  /** コマンドを適用し副作用を実行 */
  const dispatch = (command: TerminalCommand): void => {
    const transition = reduceTerminal(state, command);
    state = transition.state;
    executeEffects(transition.effects);
  };

  /** セッション生成とハンドル登録 */
  const spawnAndTrack = (spec: TerminalSessionSpec): void => {
    const handle = shellFactory.create(spec);
    handles.set(spec.id, handle);
    const disposable = handle.onExit(() => dispatch({ kind: 'sessionExited', sessionId: spec.id }));
    exitDisposables.set(spec.id, disposable);
  };

  /** 副作用の実行 */
  const executeEffects = (effects: readonly TerminalEffect[]): void => {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'spawnSession':
          spawnAndTrack(effect.spec);
          break;
        case 'attachTerminal': {
          const handle = handles.get(effect.sessionId);
          if (!handle) break;
          const terminalId = presentation.attachSession(handle, effect.title);
          dispatch({ kind: 'terminalBound', sessionId: effect.sessionId, terminalId });
          break;
        }
        case 'showTerminal':
          presentation.showTerminal(effect.terminalId);
          break;
        case 'disposeTerminal':
          presentation.disposeTerminal(effect.terminalId);
          break;
        case 'killSession': {
          exitDisposables.get(effect.sessionId)?.dispose();
          exitDisposables.delete(effect.sessionId);
          const handle = handles.get(effect.sessionId);
          if (handle) {
            handle.kill();
            handles.delete(effect.sessionId);
          }
          break;
        }
      }
    }
  };

  /** セッション仕様の構築 */
  const buildSpec = (lane: Lane): TerminalSessionSpec => ({
    id: sessionIdPort.next(lane.id),
    laneId: lane.id,
    title: lane.label,
    cwdPath: lane.rootPath,
    shellPath: deps.getShellPath(),
  });

  return {
    revealLane: (lane) => {
      // 既存の表示ターミナルを dispose（管理下のみ）
      const disposed = presentation.disposeAllOwned();
      for (const terminalId of disposed) {
        const sid = findSessionByTerminalId(state, terminalId);
        if (sid) {
          // バインド解除のみ（セッション自体は生存）
          dispatch({
            kind: 'terminalBound',
            sessionId: sid,
            terminalId: undefined as unknown as TerminalId,
          });
        }
      }

      // このレーンの生存セッション
      const laneRecord = state.lanes.get(lane.id);
      const sessionIds = laneRecord?.sessionIds ?? [];
      const aliveSessionIds = sessionIds.filter((sid) => handles.get(sid)?.isAlive());

      if (aliveSessionIds.length === 0) {
        // 新規セッション生成→アタッチ→表示
        const spec = buildSpec(lane);
        spawnAndTrack(spec);
        dispatch({ kind: 'sessionStarted', spec });
        const handle = handles.get(spec.id)!;
        const terminalId = presentation.attachSession(handle, lane.label);
        dispatch({ kind: 'terminalBound', sessionId: spec.id, terminalId });
        presentation.showTerminal(terminalId);
        dispatch({ kind: 'laneRevealed', laneId: lane.id, visibleSessionId: spec.id });
        return;
      }

      // 既存セッション復元
      const lastVisible = laneRecord?.lastVisibleSessionId;
      const visibleSessionId =
        lastVisible && aliveSessionIds.includes(lastVisible)
          ? lastVisible
          : aliveSessionIds[aliveSessionIds.length - 1]!;

      for (const sid of aliveSessionIds) {
        const handle = handles.get(sid)!;
        const record = state.sessions.get(sid)!;
        const terminalId = presentation.attachSession(handle, record.spec.title);
        dispatch({ kind: 'terminalBound', sessionId: sid, terminalId });
        if (sid === visibleSessionId) {
          presentation.showTerminal(terminalId);
        }
      }
      dispatch({ kind: 'laneRevealed', laneId: lane.id, visibleSessionId });
    },

    addTerminal: (lane) => {
      const spec = buildSpec(lane);
      spawnAndTrack(spec);
      dispatch({ kind: 'sessionStarted', spec });
      const handle = handles.get(spec.id)!;
      const terminalId = presentation.attachSession(handle, lane.label);
      dispatch({ kind: 'terminalBound', sessionId: spec.id, terminalId });
      presentation.showTerminal(terminalId);
      dispatch({ kind: 'laneRevealed', laneId: lane.id, visibleSessionId: spec.id });
    },

    closeLane: (laneId) => {
      dispatch({ kind: 'laneClosed', laneId });
    },

    handleTerminalClosed: (terminalId) => {
      dispatch({ kind: 'terminalClosed', terminalId });
    },

    managedSessionIds: () => new Set(state.sessions.keys()),

    dispose: () => {
      dispatch({ kind: 'allDisposed' });
      for (const d of exitDisposables.values()) d.dispose();
      exitDisposables.clear();
    },
  };
};
