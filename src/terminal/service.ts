import type { AbsolutePath, Disposable, LaneId, SessionId, TerminalId } from '../foundation/model';
import type { Lane } from '../lane/model';
import type {
  LaneTerminalRecord,
  TerminalCommand,
  TerminalEffect,
  TerminalSessionSpec,
} from './model';
import type {
  SessionIdPort,
  ShellSessionFactoryPort,
  ShellSessionHandle,
  TerminalPresentationPort,
} from './ports';
import { initialTerminalState, reduceTerminal } from './reducer';

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
  /** Pseudoterminal に接続するシェルハンドル */
  readonly handle: ShellSessionHandle;
  /** 生成する TerminalProfile の表示名 */
  readonly profileTitle: string;
}

/** ターミナルサービスの操作インターフェース */
export interface TerminalService {
  /**
   * 指定レーンのターミナル表示
   * @param lane - 対象レーン
   */
  readonly revealLane: (lane: Lane) => void;
  /**
   * 指定レーンの表示面を現在の表示名で再生成
   * @param lane - 対象レーン
   */
  readonly refreshLane: (lane: Lane) => void;
  /**
   * 指定レーンへの新規セッション起動とシェルハンドル取得
   * @param lane - 対象レーン
   * @returns 新規セッション識別子と Pseudoterminal 接続用シェルハンドル
   */
  readonly requestSession: (lane: Lane) => RequestedSession;
  /**
   * VS Code 側で生成されたターミナル識別子をセッションへ束縛
   * @param sessionId - 対象セッション識別子
   * @param terminalId - 束縛先ターミナル識別子
   */
  readonly bindTerminal: (sessionId: SessionId, terminalId: TerminalId) => void;
  /** 保留中の全表示面更新を失敗した段階から再開 */
  readonly finalizePendingPresentations: () => void;
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
   * セッション識別子からのレーン識別子解決
   * @param sessionId - 対象セッション識別子
   * @returns 該当レーン識別子、または不一致で undefined
   */
  readonly resolveLaneBySession: (sessionId: SessionId) => LaneId | undefined;
  /** 全リソースの破棄 */
  readonly dispose: () => void;
}

type TerminalShowMode = 'focus' | 'preserve-focus';

type TerminalRefreshTask =
  | {
      readonly phase: 'dispose';
      readonly sessionId: SessionId;
      readonly terminalId: TerminalId;
      readonly showAfterAttach: TerminalShowMode | undefined;
    }
  | {
      readonly phase: 'attach';
      readonly sessionId: SessionId;
      readonly showAfterAttach: TerminalShowMode | undefined;
    }
  | {
      readonly phase: 'show';
      readonly sessionId: SessionId;
      readonly terminalId: TerminalId;
      readonly preserveFocus: boolean;
    };

interface PendingTerminalRefresh {
  label: string;
  readonly tasks: TerminalRefreshTask[];
}

interface SessionPresentationLifecycle {
  readonly currentLabel: string;
  readonly pendingProfileLabel: string | undefined;
}

const appendFailure = (failures: unknown[], error: unknown): void => {
  if (error instanceof AggregateError) {
    failures.push(...error.errors);
    return;
  }
  failures.push(error);
};

const throwFailures = (failures: readonly unknown[]): void => {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, 'Terminal cleanup failed.');
};

/**
 * レーン記録から再表示するセッションの解決
 * @param laneRecord - 1件以上のセッションを持つレーン記録
 * @returns 直近表示セッション、または残存末尾セッション
 */
const resolveVisibleSessionId = (laneRecord: LaneTerminalRecord): SessionId => {
  const { lastVisibleSessionId, sessionIds } = laneRecord;
  return lastVisibleSessionId && sessionIds.includes(lastVisibleSessionId)
    ? lastVisibleSessionId
    : sessionIds[sessionIds.length - 1]!;
};

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
  const pendingRefreshes = new Map<LaneId, PendingTerminalRefresh>();
  const sessionPresentations = new Map<SessionId, SessionPresentationLifecycle>();

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
    const failures: unknown[] = [];
    for (const effect of effects) {
      switch (effect.kind) {
        case 'disposeTerminal': {
          try {
            presentation.disposeTerminal(effect.terminalId);
          } catch (error) {
            appendFailure(failures, error);
          }
          break;
        }
        case 'killSession': {
          const exitDisposable = exitDisposables.get(effect.sessionId);
          exitDisposables.delete(effect.sessionId);
          const handle = handles.get(effect.sessionId);
          handles.delete(effect.sessionId);
          sessionPresentations.delete(effect.sessionId);
          try {
            exitDisposable?.dispose();
          } catch (error) {
            appendFailure(failures, error);
          }
          if (handle) {
            try {
              handle.kill();
            } catch (error) {
              appendFailure(failures, error);
            }
          }
          break;
        }
      }
    }
    throwFailures(failures);
  };

  /**
   * セッション仕様の構築
   * @param lane - 対象レーン
   * @returns セッション仕様
   */
  const buildSpec = (lane: Lane): TerminalSessionSpec => ({
    id: sessionIdPort.next(lane.id),
    laneId: lane.id,
    cwdPath: lane.rootPath,
    shellPath: deps.getShellPath(),
  });

  /**
   * セッションの生成、ハンドル登録、終了監視の登録
   * @param spec - セッション仕様
   * @param presentationLifecycle - 表示面 lifecycle の初期状態
   * @returns Pseudoterminal 接続用シェルハンドル
   */
  const spawnSession = (
    spec: TerminalSessionSpec,
    presentationLifecycle: SessionPresentationLifecycle,
  ): ShellSessionHandle => {
    const handle = shellFactory.create(spec);
    handles.set(spec.id, handle);
    sessionPresentations.set(spec.id, presentationLifecycle);
    dispatch({ kind: 'sessionStarted', spec });
    const disposable = handle.onExit(() => {
      exitDisposables.get(spec.id)?.dispose();
      exitDisposables.delete(spec.id);
      handles.delete(spec.id);
      sessionPresentations.delete(spec.id);
      dispatch({ kind: 'sessionExited', sessionId: spec.id });
    });
    if (state.sessions.has(spec.id)) {
      exitDisposables.set(spec.id, disposable);
    } else {
      disposable.dispose();
    }
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

  /**
   * 消滅した可視セッションの表示責務を残存セッションへ移譲
   * @param laneId - 対象レーン識別子
   * @param pending - 更新中の表示面タスク
   */
  const transferPreserveFocus = (laneId: LaneId, pending: PendingTerminalRefresh): void => {
    const laneRecord = state.lanes.get(laneId);
    if (!laneRecord) return;

    const fallbackSessionId = resolveVisibleSessionId(laneRecord);
    const taskIndex = pending.tasks.findIndex((task) => task.sessionId === fallbackSessionId);
    if (taskIndex >= 0) {
      const task = pending.tasks[taskIndex]!;
      if (task.phase === 'show' || task.showAfterAttach === 'focus') return;
      pending.tasks[taskIndex] = { ...task, showAfterAttach: 'preserve-focus' };
      return;
    }

    const terminalId = state.sessions.get(fallbackSessionId)?.terminalId;
    if (!terminalId) return;
    pending.tasks.push({
      phase: 'show',
      sessionId: fallbackSessionId,
      terminalId,
      preserveFocus: true,
    });
  };

  /**
   * 保留中の表示面更新を失敗した段階から再開
   * @param laneId - 対象レーン識別子
   * @param pending - 保留中の更新
   */
  const resumeTerminalRefresh = (laneId: LaneId, pending: PendingTerminalRefresh): void => {
    while (pending.tasks.length > 0) {
      const task = pending.tasks[0]!;
      if (!state.sessions.has(task.sessionId) || !handles.has(task.sessionId)) {
        pending.tasks.shift();
        const preserveFocusRequired =
          task.phase === 'show' ? task.preserveFocus : task.showAfterAttach === 'preserve-focus';
        if (preserveFocusRequired) transferPreserveFocus(laneId, pending);
        continue;
      }

      if (task.phase === 'dispose') {
        dispatch({ kind: 'terminalUnbound', sessionId: task.sessionId });
        presentation.disposeTerminal(task.terminalId);
        pending.tasks[0] = {
          phase: 'attach',
          sessionId: task.sessionId,
          showAfterAttach: task.showAfterAttach,
        };
        continue;
      }

      if (task.phase === 'attach') {
        const terminalId = attachExisting(task.sessionId, pending.label);
        if (task.showAfterAttach !== undefined) {
          pending.tasks[0] = {
            phase: 'show',
            sessionId: task.sessionId,
            terminalId,
            preserveFocus: task.showAfterAttach === 'preserve-focus',
          };
        } else {
          pending.tasks.shift();
        }
        continue;
      }

      presentation.showTerminal(task.terminalId, task.preserveFocus);
      pending.tasks.shift();
    }
    pendingRefreshes.delete(laneId);
  };

  /**
   * 保留中の表示面更新を最新 label と現在の bind 状態へ再構成
   * @param laneId - 対象レーン識別子
   * @param label - 最新表示名
   * @param pending - 保留中の更新
   */
  const retargetTerminalRefresh = (
    laneId: LaneId,
    label: string,
    pending: PendingTerminalRefresh,
  ): void => {
    const laneRecord = state.lanes.get(laneId);
    if (!laneRecord) {
      pending.label = label;
      pending.tasks.splice(0);
      return;
    }

    const taskBySession = new Map(pending.tasks.map((task) => [task.sessionId, task]));
    const tasks = laneRecord.sessionIds.flatMap((sessionId): TerminalRefreshTask[] => {
      const record = state.sessions.get(sessionId);
      if (!record || !handles.has(sessionId)) return [];

      const existing = taskBySession.get(sessionId);
      const showAfterAttach =
        existing?.phase === 'show'
          ? existing.preserveFocus
            ? 'preserve-focus'
            : 'focus'
          : existing?.showAfterAttach;
      if (existing?.phase === 'dispose') return [existing];
      if (existing?.phase === 'attach') {
        return [{ phase: 'attach', sessionId, showAfterAttach }];
      }
      if (record.terminalId) {
        return [
          {
            phase: 'dispose',
            sessionId,
            terminalId: record.terminalId,
            showAfterAttach,
          },
        ];
      }
      return existing?.phase === 'show' ? [{ phase: 'attach', sessionId, showAfterAttach }] : [];
    });

    pending.label = label;
    pending.tasks.splice(0, pending.tasks.length, ...tasks);
  };

  return {
    revealLane: (lane) => {
      for (const [sessionId, record] of state.sessions) {
        if (record.terminalId) dispatch({ kind: 'terminalUnbound', sessionId });
      }
      presentation.disposeAllOwned();
      pendingRefreshes.clear();

      const laneRecord = state.lanes.get(lane.id);
      const sessionIds = laneRecord?.sessionIds ?? [];

      if (!laneRecord || sessionIds.length === 0) {
        const spec = buildSpec(lane);
        spawnSession(spec, {
          currentLabel: lane.label,
          pendingProfileLabel: undefined,
        });
        if (!state.sessions.has(spec.id)) return;
        const terminalId = attachExisting(spec.id, lane.label);
        presentation.showTerminal(terminalId);
        dispatch({ kind: 'laneRevealed', laneId: lane.id, visibleSessionId: spec.id });
        return;
      }

      const visibleSessionId = resolveVisibleSessionId(laneRecord);

      for (const sessionId of sessionIds) {
        const terminalId = attachExisting(sessionId, lane.label);
        if (sessionId === visibleSessionId) presentation.showTerminal(terminalId);
      }
      dispatch({ kind: 'laneRevealed', laneId: lane.id, visibleSessionId });
    },

    refreshLane: (lane) => {
      const laneRecord = state.lanes.get(lane.id);
      if (!laneRecord) {
        pendingRefreshes.delete(lane.id);
        return;
      }
      for (const sessionId of laneRecord.sessionIds) {
        const lifecycle = sessionPresentations.get(sessionId);
        if (lifecycle) {
          sessionPresentations.set(sessionId, { ...lifecycle, currentLabel: lane.label });
        }
      }

      let pending = pendingRefreshes.get(lane.id);
      if (!pending) {
        const visibleSessionId = resolveVisibleSessionId(laneRecord);
        pending = {
          label: lane.label,
          tasks: laneRecord.sessionIds.flatMap((sessionId): TerminalRefreshTask[] => {
            const terminalId = state.sessions.get(sessionId)?.terminalId;
            return terminalId
              ? [
                  {
                    phase: 'dispose',
                    sessionId,
                    terminalId,
                    showAfterAttach: visibleSessionId === sessionId ? 'preserve-focus' : undefined,
                  },
                ]
              : [];
          }),
        };
        pendingRefreshes.set(lane.id, pending);
      } else if (pending.label !== lane.label) {
        retargetTerminalRefresh(lane.id, lane.label, pending);
      }
      resumeTerminalRefresh(lane.id, pending);
    },

    requestSession: (lane) => {
      const spec = buildSpec(lane);
      const handle = spawnSession(spec, {
        currentLabel: lane.label,
        pendingProfileLabel: lane.label,
      });
      dispatch({ kind: 'laneRevealed', laneId: lane.id, visibleSessionId: spec.id });
      return { sessionId: spec.id, handle, profileTitle: lane.label };
    },

    bindTerminal: (sessionId, terminalId) => {
      const record = state.sessions.get(sessionId);
      const lifecycle = sessionPresentations.get(sessionId);
      dispatch({ kind: 'terminalBound', sessionId, terminalId });
      if (!record || !lifecycle?.pendingProfileLabel) return;

      sessionPresentations.set(sessionId, {
        ...lifecycle,
        pendingProfileLabel: undefined,
      });
      if (lifecycle.pendingProfileLabel === lifecycle.currentLabel) return;

      let pending = pendingRefreshes.get(record.spec.laneId);
      if (!pending) {
        pending = { label: lifecycle.currentLabel, tasks: [] };
        pendingRefreshes.set(record.spec.laneId, pending);
      }
      pending.tasks.push({
        phase: 'dispose',
        sessionId,
        terminalId,
        showAfterAttach: 'focus',
      });
      if (pending.label !== lifecycle.currentLabel) {
        retargetTerminalRefresh(record.spec.laneId, lifecycle.currentLabel, pending);
      }
      resumeTerminalRefresh(record.spec.laneId, pending);
    },

    finalizePendingPresentations: () => {
      const failures: unknown[] = [];
      for (const [laneId, pending] of pendingRefreshes) {
        try {
          resumeTerminalRefresh(laneId, pending);
        } catch (error) {
          appendFailure(failures, error);
        }
      }
      throwFailures(failures);
    },

    closeLane: (laneId) => {
      pendingRefreshes.delete(laneId);
      dispatch({ kind: 'laneClosed', laneId });
    },

    handleTerminalClosed: (terminalId) => {
      dispatch({ kind: 'terminalClosed', terminalId });
    },

    resolveLaneBySession: (sessionId) => state.sessions.get(sessionId)?.spec.laneId,

    dispose: () => {
      try {
        dispatch({ kind: 'allDisposed' });
      } finally {
        pendingRefreshes.clear();
      }
    },
  };
};
