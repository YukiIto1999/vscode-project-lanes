import type { Instant, LaneId, SessionId } from '../foundation/model';
import type {
  LaneActivity,
  LaneActivityRecord,
  LaneActivityState,
  SessionActivity,
  SessionActivityEvent,
  SessionActivityState,
} from './model';
import type { LaneResolverPort } from './ports';

/**
 * 出力途絶を待機中とみなす猶予時間 (ms)。
 * 出力が観測されてから本値以内に追加出力が無ければ、エージェントは
 * 入力待機状態とみなされる。
 */
export const ACTIVE_THRESHOLD_MS = 1500;

/**
 * 入力直後の出力をエコーとみなす最小ギャップ (ms)。
 * 入力 (打鍵) から本値未満で観測された出力はエコー (シェル / TUI 由来の
 * 自前再描画) と区別がつかないため、エージェント活動シグナルとして
 * 採用しない。値はエージェントの典型応答開始遅延 (200ms 以上) を
 * 下回ることが必須。
 */
export const ECHO_GAP_MS = 100;

const ZERO: Instant = 0 as Instant;

const emptySessionState = (): SessionActivityState => ({
  fgRunning: false,
  lastOutputAt: ZERO,
  lastInputAt: ZERO,
});

/**
 * 空の初期状態の生成
 * @returns 初期状態
 */
export const initialLaneActivityState = (): LaneActivityState => ({
  sessions: new Map(),
});

/**
 * 純粋状態遷移
 * @param state - 遷移前状態
 * @param event - 遷移イベント
 * @returns 遷移後状態
 */
export const reduceLaneActivity = (
  state: LaneActivityState,
  event: SessionActivityEvent,
): LaneActivityState => {
  const sessions = new Map(state.sessions);
  const current = sessions.get(event.sessionId) ?? emptySessionState();

  switch (event.kind) {
    case 'fg-started':
      sessions.set(event.sessionId, { ...current, fgRunning: true, lastOutputAt: event.at });
      break;
    case 'fg-ended':
      sessions.set(event.sessionId, { ...current, fgRunning: false });
      break;
    case 'output':
      sessions.set(event.sessionId, { ...current, lastOutputAt: event.at });
      break;
    case 'input':
      sessions.set(event.sessionId, { ...current, lastInputAt: event.at });
      break;
    case 'forgotten':
      sessions.delete(event.sessionId);
      break;
  }

  return { sessions };
};

/**
 * セッション単位の活動状態の射影。
 * foreground 中で「直近出力が閾値内 AND 入力よりエコーギャップ以上
 * 後に発生」のときのみ working、それ以外の foreground 中は waiting、
 * foreground 外は shell-prompt。
 * @param state - セッション状態
 * @param now - 現在時刻
 * @param thresholdMs - 出力途絶を待機中とみなす猶予時間 (ms)
 * @param echoGapMs - エコーとみなす最小ギャップ (ms)
 * @returns セッション活動状態
 */
export const projectSessionActivity = (
  state: SessionActivityState,
  now: Instant,
  thresholdMs: number = ACTIVE_THRESHOLD_MS,
  echoGapMs: number = ECHO_GAP_MS,
): SessionActivity => {
  if (!state.fgRunning) return 'shell-prompt';
  const sinceOutput = now - state.lastOutputAt;
  const outputAfterInput = state.lastOutputAt - state.lastInputAt;
  if (sinceOutput < thresholdMs && outputAfterInput > echoGapMs) return 'agent-working';
  return 'agent-waiting';
};

/**
 * セッション活動列のレーン単位集約
 * @param activities - 活動状態列
 * @returns 集約活動状態 (working > waiting > no-agent の順で最大優先)
 */
export const aggregateLaneActivity = (activities: readonly SessionActivity[]): LaneActivity => {
  if (activities.some((a) => a === 'agent-working')) return 'agent-working';
  if (activities.some((a) => a === 'agent-waiting')) return 'agent-waiting';
  return 'no-agent';
};

/**
 * 状態とレーン解決ポートからのレーン活動レコード射影
 * @param state - 射影元状態
 * @param resolver - レーン解決ポート
 * @param knownLaneIds - 表示対象レーン識別子列
 * @param now - 現在時刻
 * @param thresholdMs - 出力途絶を待機中とみなす猶予時間 (ms)
 * @param echoGapMs - エコーとみなす最小ギャップ (ms)
 * @returns レーン活動レコード列
 */
export const projectLaneActivities = (
  state: LaneActivityState,
  resolver: LaneResolverPort,
  knownLaneIds: Iterable<LaneId>,
  now: Instant,
  thresholdMs: number = ACTIVE_THRESHOLD_MS,
  echoGapMs: number = ECHO_GAP_MS,
): readonly LaneActivityRecord[] => {
  const byLane = new Map<LaneId, SessionActivity[]>();
  for (const [sessionId, sessionState] of state.sessions) {
    const laneId = resolver.resolveLaneBySession(sessionId);
    if (!laneId) continue;
    const activity = projectSessionActivity(sessionState, now, thresholdMs, echoGapMs);
    const arr = byLane.get(laneId) ?? [];
    arr.push(activity);
    byLane.set(laneId, arr);
  }

  return [...knownLaneIds].map((laneId) => ({
    laneId,
    activity: aggregateLaneActivity(byLane.get(laneId) ?? []),
  }));
};

/**
 * セッション全体の射影マップ (差分判定用)
 * @param state - 射影元状態
 * @param now - 現在時刻
 * @param thresholdMs - 出力途絶を待機中とみなす猶予時間 (ms)
 * @param echoGapMs - エコーとみなす最小ギャップ (ms)
 * @returns セッション活動マップ
 */
export const projectSessionMap = (
  state: LaneActivityState,
  now: Instant,
  thresholdMs: number = ACTIVE_THRESHOLD_MS,
  echoGapMs: number = ECHO_GAP_MS,
): ReadonlyMap<SessionId, SessionActivity> => {
  const out = new Map<SessionId, SessionActivity>();
  for (const [sessionId, sessionState] of state.sessions) {
    out.set(sessionId, projectSessionActivity(sessionState, now, thresholdMs, echoGapMs));
  }
  return out;
};

/**
 * 2 つの射影マップが等しいか
 * @param a - 比較元
 * @param b - 比較先
 * @returns 等しければ true
 */
export const equalSessionMap = (
  a: ReadonlyMap<SessionId, SessionActivity>,
  b: ReadonlyMap<SessionId, SessionActivity>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
};

/**
 * 次に状態遷移が起きる予想時刻 (絶対値) の算出
 * @param state - 現在状態
 * @param now - 現在時刻
 * @param thresholdMs - 出力途絶を待機中とみなす猶予時間 (ms)
 * @returns 次の遷移時刻、無ければ undefined
 */
export const nextTransitionAt = (
  state: LaneActivityState,
  now: Instant,
  thresholdMs: number = ACTIVE_THRESHOLD_MS,
): Instant | undefined => {
  let earliest: Instant | undefined;
  for (const s of state.sessions.values()) {
    if (!s.fgRunning) continue;
    const transitionAt = (s.lastOutputAt + thresholdMs) as Instant;
    if (transitionAt <= now) continue;
    if (earliest === undefined || transitionAt < earliest) earliest = transitionAt;
  }
  return earliest;
};
