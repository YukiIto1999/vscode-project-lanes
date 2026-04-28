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

/** セッション要求の戻り値 */
export interface RequestedSession {
  /** 新規セッション識別子 */
  readonly sessionId: SessionId;
  /** 接続用シェルハンドル */
  readonly handle: ShellSessionHandle;
}

/** ターミナルサービスの操作インターフェース */
export interface TerminalService {
  /**
   * 指定レーンのターミナル表示
   * @param lane - 対象レーン
   */
  readonly revealLane: (lane: Lane) => void;
  /**
   * 指定レーンへの新規セッション起動と接続用ハンドル取得
   * @param lane - 対象レーン
   * @returns 新規セッション識別子と接続用ハンドル
   */
  readonly requestSession: (lane: Lane) => RequestedSession;
  /**
   * VS Code 側で生成されたターミナル識別子をセッションへ束縛
   * @param sessionId - 対象セッション識別子
   * @param terminalId - 束縛先ターミナル識別子
   */
  readonly bindTerminal: (sessionId: SessionId, terminalId: TerminalId) => void;
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
  /**
   * ターミナル識別子からのレーン識別子解決
   * @param terminalId - 対象ターミナル識別子
   * @returns 該当レーン識別子、または不一致で undefined
   */
  readonly resolveLaneByTerminal: (terminalId: TerminalId) => LaneId | undefined;
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
   * 副作用の実行
   * @param effects - 実行対象副作用列
   */
  const executeEffects = (effects: readonly TerminalEffect[]): void => {
    for (const effect of effects) {
      switch (effect.kind) {
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

  /**
   * セッションの生成、ハンドル登録、終了監視の登録
   * @param spec - セッション仕様
   * @returns 接続用ハンドル
   */
  const spawnSession = (spec: TerminalSessionSpec): ShellSessionHandle => {
    const handle = shellFactory.create(spec);
    handles.set(spec.id, handle);
    const disposable = handle.onExit(() => dispatch({ kind: 'sessionExited', sessionId: spec.id }));
    exitDisposables.set(spec.id, disposable);
    dispatch({ kind: 'sessionStarted', spec });
    return handle;
  };

  /**
   * 既存ハンドルの新規 Terminal への再接続
   * @param sessionId - 対象セッション識別子
   * @param title - 表示タイトル
   * @returns 新規 TerminalId
   */
  const attachExisting = (sessionId: SessionId, title: string): TerminalId => {
    const handle = handles.get(sessionId)!;
    const terminalId = presentation.attachSession(handle, title);
    dispatch({ kind: 'terminalBound', sessionId, terminalId });
    return terminalId;
  };

  return {
    revealLane: (lane) => {
      const disposed = presentation.disposeAllOwned();
      for (const terminalId of disposed) {
        const sid = findSessionByTerminalId(state, terminalId);
        if (sid) dispatch({ kind: 'terminalUnbound', sessionId: sid });
      }

      const laneRecord = state.lanes.get(lane.id);
      const sessionIds = laneRecord?.sessionIds ?? [];
      const aliveSessionIds = sessionIds.filter((sid) => handles.get(sid)?.isAlive());

      if (aliveSessionIds.length === 0) {
        const spec = buildSpec(lane);
        spawnSession(spec);
        const terminalId = attachExisting(spec.id, lane.label);
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
        const record = state.sessions.get(sid)!;
        const terminalId = attachExisting(sid, record.spec.title);
        if (sid === visibleSessionId) presentation.showTerminal(terminalId);
      }
      dispatch({ kind: 'laneRevealed', laneId: lane.id, visibleSessionId });
    },

    requestSession: (lane) => {
      const spec = buildSpec(lane);
      const handle = spawnSession(spec);
      dispatch({ kind: 'laneRevealed', laneId: lane.id, visibleSessionId: spec.id });
      return { sessionId: spec.id, handle };
    },

    bindTerminal: (sessionId, terminalId) => {
      dispatch({ kind: 'terminalBound', sessionId, terminalId });
    },

    closeLane: (laneId) => {
      dispatch({ kind: 'laneClosed', laneId });
    },

    handleTerminalClosed: (terminalId) => {
      dispatch({ kind: 'terminalClosed', terminalId });
    },

    managedSessionIds: () => new Set(state.sessions.keys()),

    resolveLaneByTerminal: (terminalId) => {
      const sessionId = findSessionByTerminalId(state, terminalId);
      if (!sessionId) return undefined;
      return state.sessions.get(sessionId)?.spec.laneId;
    },

    dispose: () => {
      dispatch({ kind: 'allDisposed' });
      for (const d of exitDisposables.values()) d.dispose();
      exitDisposables.clear();
    },
  };
};
