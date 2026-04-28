import type { Disposable } from '../foundation/model';
import type { LaneActivityState } from './model';
import type {
  MonotonicClockPort,
  TerminalExecutionEventPort,
  TerminalInputEventPort,
  TerminalLifecycleEventPort,
  TerminalOutputEventPort,
} from './ports';
import {
  ACTIVE_THRESHOLD_MS,
  initialLaneActivityState,
  nextTransitionAt,
  reduceLaneActivity,
} from './reducer';

/** レーン活動サービスの依存 */
export interface LaneActivityServiceDeps {
  /** foreground 開始 / 終了の入力ポート */
  readonly executionEvents: TerminalExecutionEventPort;
  /** 出力観測の入力ポート */
  readonly outputEvents: TerminalOutputEventPort;
  /** 入力観測の入力ポート */
  readonly inputEvents: TerminalInputEventPort;
  /** ターミナル消滅の入力ポート */
  readonly lifecycleEvents: TerminalLifecycleEventPort;
  /** 単調時刻 */
  readonly clock: MonotonicClockPort;
  /** 出力途絶を待機中とみなす猶予時間 (ms) */
  readonly thresholdMs?: number;
}

/** レーン活動サービス */
export interface LaneActivityService {
  /**
   * 直近状態の取得
   * @returns 現在の状態
   */
  readonly snapshot: () => LaneActivityState;
  /**
   * 状態変更通知の購読
   * @param handler - 通知ハンドラー
   * @returns 購読解除可能な Disposable
   */
  readonly onChange: (handler: () => void) => Disposable;
  /** 全リソースの破棄 */
  readonly dispose: () => void;
}

/**
 * レーン活動サービスの生成
 * @param deps - 依存
 * @returns サービスインスタンス
 */
export const createLaneActivityService = (deps: LaneActivityServiceDeps): LaneActivityService => {
  const thresholdMs = deps.thresholdMs ?? ACTIVE_THRESHOLD_MS;
  let state = initialLaneActivityState();
  const handlers: Array<() => void> = [];
  let pendingTimer: NodeJS.Timeout | null = null;

  const notify = (): void => {
    for (const handler of handlers) handler();
  };

  const scheduleNextTransition = (): void => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    const now = deps.clock.now();
    const transitionAt = nextTransitionAt(state, now, thresholdMs);
    if (transitionAt === undefined) return;
    pendingTimer = setTimeout(
      () => {
        pendingTimer = null;
        notify();
        scheduleNextTransition();
      },
      transitionAt - now + 50,
    );
  };

  const execSubscription = deps.executionEvents.subscribe((event) => {
    if (event.kind === 'started') {
      state = reduceLaneActivity(state, {
        kind: 'fg-started',
        terminalId: event.terminalId,
        at: deps.clock.now(),
      });
    } else {
      state = reduceLaneActivity(state, { kind: 'fg-ended', terminalId: event.terminalId });
    }
    notify();
    scheduleNextTransition();
  });

  const outputSubscription = deps.outputEvents.subscribe((event) => {
    state = reduceLaneActivity(state, {
      kind: 'output',
      terminalId: event.terminalId,
      at: deps.clock.now(),
    });
    notify();
    scheduleNextTransition();
  });

  const inputSubscription = deps.inputEvents.subscribe((event) => {
    state = reduceLaneActivity(state, {
      kind: 'input',
      terminalId: event.terminalId,
      at: deps.clock.now(),
    });
    notify();
    scheduleNextTransition();
  });

  const lifecycleSubscription = deps.lifecycleEvents.subscribe((terminalId) => {
    state = reduceLaneActivity(state, { kind: 'forgotten', terminalId });
    notify();
    scheduleNextTransition();
  });

  return {
    snapshot: () => state,
    onChange: (handler) => {
      handlers.push(handler);
      return {
        dispose: () => {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        },
      };
    },
    dispose: () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      execSubscription.dispose();
      outputSubscription.dispose();
      inputSubscription.dispose();
      lifecycleSubscription.dispose();
      handlers.length = 0;
    },
  };
};
