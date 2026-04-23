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
  /** シェルセッション生成ポート */
  readonly shellFactory: ShellSessionFactoryPort;
  /** ターミナル表示ポート */
  readonly presentation: TerminalPresentationPort;
  /** セッション ID 採番ポート */
  readonly sessionId: SessionIdPort;
  /** シェル絶対パスの取得 */
  readonly getShellPath: () => AbsolutePath | undefined;
}

/** ターミナルサービスの操作インターフェース */
export interface TerminalService {
  /**
   * 指定レーンのターミナル表示
   * @param lane - 対象レーン
   */
  readonly revealLane: (lane: Lane) => void;
  /**
   * 指定レーンへの新規ターミナル追加
   * @param lane - 対象レーン
   */
  readonly addTerminal: (lane: Lane) => void;
  /**
   * 指定レーンの全ターミナル終了
   * @param laneId - 対象レーン識別子
   */
  readonly closeLane: (laneId: LaneId) => void;
  /**
   * VS Code からのターミナル終了通知の処理
   * @param terminalId - 対象ターミナル識別子
   */
  readonly handleTerminalClosed: (terminalId: TerminalId) => void;
  /**
   * 管理中セッション識別子の取得
   * @returns 管理中セッション識別子の集合
   */
  readonly managedSessionIds: () => ReadonlySet<SessionId>;
  /** 全リソースの破棄 */
  readonly dispose: () => void;
}

/**
 * ターミナルサービスの生成
 * @param deps - 依存
 * @returns サービスインスタンス
 */
export const createTerminalService = (deps: TerminalServiceDeps): TerminalService => {
  const { shellFactory, presentation, sessionId: sessionIdPort } = deps;
  let state = initialTerminalState();
  const handles = new Map<SessionId, ShellSessionHandle>();
  const exitDisposables = new Map<SessionId, Disposable>();

  /**
   * コマンド適用と副作用実行
   * @param command - 適用コマンド
   */
  const dispatch = (command: TerminalCommand): void => {
    const transition = reduceTerminal(state, command);
    state = transition.state;
    executeEffects(transition.effects);
  };

  /**
   * セッション生成とハンドル登録
   * @param spec - セッション仕様
   */
  const spawnAndTrack = (spec: TerminalSessionSpec): void => {
    const handle = shellFactory.create(spec);
    handles.set(spec.id, handle);
    const disposable = handle.onExit(() => dispatch({ kind: 'sessionExited', sessionId: spec.id }));
    exitDisposables.set(spec.id, disposable);
  };

  /**
   * 副作用の実行
   * @param effects - 実行対象副作用列
   */
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

  /**
   * セッション仕様の構築
   * @param lane - 対象レーン
   * @returns セッション仕様
   */
  const buildSpec = (lane: Lane): TerminalSessionSpec => ({
    id: sessionIdPort.next(lane.id),
    laneId: lane.id,
    title: lane.label,
    cwdPath: lane.rootPath,
    shellPath: deps.getShellPath(),
  });

  return {
    revealLane: (lane) => {
      const disposed = presentation.disposeAllOwned();
      for (const terminalId of disposed) {
        const sid = findSessionByTerminalId(state, terminalId);
        if (sid) {
          dispatch({
            kind: 'terminalBound',
            sessionId: sid,
            terminalId: undefined as unknown as TerminalId,
          });
        }
      }

      const laneRecord = state.lanes.get(lane.id);
      const sessionIds = laneRecord?.sessionIds ?? [];
      const aliveSessionIds = sessionIds.filter((sid) => handles.get(sid)?.isAlive());

      if (aliveSessionIds.length === 0) {
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
