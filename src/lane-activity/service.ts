import type { Disposable, SessionId } from '../foundation/model';
import type { LaneActivityState, SessionActivity } from './model';
import type { MonotonicClockPort, SessionActivitySink } from './ports';
import {
  ACTIVE_THRESHOLD_MS,
  ECHO_GAP_MS,
  equalSessionMap,
  initialLaneActivityState,
  nextTransitionAt,
  projectSessionMap,
  reduceLaneActivity,
} from './reducer';

/** レーン活動サービスの依存 */
export interface LaneActivityServiceDeps {
  /** 単調時刻 */
  readonly clock: MonotonicClockPort;
  /** 出力途絶を待機中とみなす猶予時間 (ms) */
  readonly thresholdMs?: number;
  /** エコーとみなす最小ギャップ (ms) */
  readonly echoGapMs?: number;
}

/** レーン活動サービス */
export interface LaneActivityService {
  /** adapter からの事実流入口 */
  readonly sink: SessionActivitySink;
  /**
   * 直近状態の取得
   * @returns 現在の状態
   */
  readonly snapshot: () => LaneActivityState;
  /**
   * 状態変更通知の購読 (射影が変化したときのみ発火)
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
  const echoGapMs = deps.echoGapMs ?? ECHO_GAP_MS;
  let state = initialLaneActivityState();
  let lastProjection: ReadonlyMap<SessionId, SessionActivity> = new Map();
  const handlers: Array<() => void> = [];
  let pendingTimer: NodeJS.Timeout | null = null;

  const fire = (): void => {
    for (const handler of handlers) handler();
  };

  const recompute = (): void => {
    const next = projectSessionMap(state, deps.clock.now(), thresholdMs, echoGapMs);
    if (equalSessionMap(lastProjection, next)) return;
    lastProjection = next;
    fire();
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
        recompute();
        scheduleNextTransition();
      },
      transitionAt - now + 50,
    );
  };

  const sink: SessionActivitySink = {
    executionStarted: (sessionId) => {
      state = reduceLaneActivity(state, {
        kind: 'fg-started',
        sessionId,
        at: deps.clock.now(),
      });
      recompute();
      scheduleNextTransition();
    },
    executionEnded: (sessionId) => {
      state = reduceLaneActivity(state, { kind: 'fg-ended', sessionId });
      recompute();
      scheduleNextTransition();
    },
    output: (sessionId) => {
      state = reduceLaneActivity(state, {
        kind: 'output',
        sessionId,
        at: deps.clock.now(),
      });
      recompute();
      scheduleNextTransition();
    },
    input: (sessionId) => {
      state = reduceLaneActivity(state, {
        kind: 'input',
        sessionId,
        at: deps.clock.now(),
      });
      recompute();
      scheduleNextTransition();
    },
    forgotten: (sessionId) => {
      state = reduceLaneActivity(state, { kind: 'forgotten', sessionId });
      recompute();
      scheduleNextTransition();
    },
  };

  return {
    sink,
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
      handlers.length = 0;
    },
  };
};
