import type { LaneId } from '../foundation/model';
import type {
  LaneActivity,
  LaneActivityRecord,
  LaneActivityState,
  TerminalActivity,
  TerminalActivityEvent,
  TerminalActivityState,
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

const emptyTerminalState = (): TerminalActivityState => ({
  fgRunning: false,
  lastOutputAt: 0,
  lastInputAt: 0,
});

/**
 * 空の初期状態の生成
 * @returns 初期状態
 */
export const initialLaneActivityState = (): LaneActivityState => ({
  terminals: new Map(),
});

/**
 * 純粋状態遷移
 * @param state - 遷移前状態
 * @param event - 遷移イベント
 * @returns 遷移後状態
 */
export const reduceLaneActivity = (
  state: LaneActivityState,
  event: TerminalActivityEvent,
): LaneActivityState => {
  const terminals = new Map(state.terminals);
  const current = terminals.get(event.terminalId) ?? emptyTerminalState();

  switch (event.kind) {
    case 'fg-started':
      terminals.set(event.terminalId, { ...current, fgRunning: true, lastOutputAt: event.at });
      break;
    case 'fg-ended':
      terminals.set(event.terminalId, { ...current, fgRunning: false });
      break;
    case 'output':
      terminals.set(event.terminalId, { ...current, lastOutputAt: event.at });
      break;
    case 'input':
      terminals.set(event.terminalId, { ...current, lastInputAt: event.at });
      break;
    case 'forgotten':
      terminals.delete(event.terminalId);
      break;
  }

  return { terminals };
};

/**
 * ターミナル単位の活動状態の射影。
 * foreground 中で「直近出力が閾値内 AND 入力よりエコーギャップ以上
 * 後に発生」のときのみ working、それ以外の foreground 中は waiting、
 * foreground 外は shell-prompt。
 * @param state - ターミナル状態
 * @param now - 現在時刻 (ms)
 * @param thresholdMs - 出力途絶を待機中とみなす猶予時間 (ms)
 * @param echoGapMs - エコーとみなす最小ギャップ (ms)
 * @returns ターミナル活動状態
 */
export const projectTerminalActivity = (
  state: TerminalActivityState,
  now: number,
  thresholdMs: number = ACTIVE_THRESHOLD_MS,
  echoGapMs: number = ECHO_GAP_MS,
): TerminalActivity => {
  if (!state.fgRunning) return 'shell-prompt';
  const sinceOutput = now - state.lastOutputAt;
  const outputAfterInput = state.lastOutputAt - state.lastInputAt;
  if (sinceOutput < thresholdMs && outputAfterInput > echoGapMs) return 'agent-working';
  return 'agent-waiting';
};

/**
 * ターミナル活動列のレーン単位集約
 * @param activities - 活動状態列
 * @returns 集約活動状態 (working > waiting > no-agent の順で最大優先)
 */
export const aggregateLaneActivity = (activities: readonly TerminalActivity[]): LaneActivity => {
  if (activities.some((a) => a === 'agent-working')) return 'agent-working';
  if (activities.some((a) => a === 'agent-waiting')) return 'agent-waiting';
  return 'no-agent';
};

/**
 * 状態とレーン解決ポートからのレーン活動レコード射影
 * @param state - 射影元状態
 * @param resolver - レーン解決ポート
 * @param knownLaneIds - 表示対象レーン識別子列
 * @param now - 現在時刻 (ms)
 * @param thresholdMs - 出力途絶を待機中とみなす猶予時間 (ms)
 * @param echoGapMs - エコーとみなす最小ギャップ (ms)
 * @returns レーン活動レコード列
 */
export const projectLaneActivities = (
  state: LaneActivityState,
  resolver: LaneResolverPort,
  knownLaneIds: Iterable<LaneId>,
  now: number,
  thresholdMs: number = ACTIVE_THRESHOLD_MS,
  echoGapMs: number = ECHO_GAP_MS,
): readonly LaneActivityRecord[] => {
  const byLane = new Map<LaneId, TerminalActivity[]>();
  for (const [terminalId, terminalState] of state.terminals) {
    const laneId = resolver.resolveLaneByTerminal(terminalId);
    if (!laneId) continue;
    const activity = projectTerminalActivity(terminalState, now, thresholdMs, echoGapMs);
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
 * 次に状態遷移が起きる予想時刻 (ms 絶対値) の算出
 * @param state - 現在状態
 * @param now - 現在時刻 (ms)
 * @param thresholdMs - 出力途絶を待機中とみなす猶予時間 (ms)
 * @returns 次の遷移時刻、無ければ undefined
 */
export const nextTransitionAt = (
  state: LaneActivityState,
  now: number,
  thresholdMs: number = ACTIVE_THRESHOLD_MS,
): number | undefined => {
  let earliest: number | undefined;
  for (const t of state.terminals.values()) {
    if (!t.fgRunning) continue;
    const transitionAt = t.lastOutputAt + thresholdMs;
    if (transitionAt <= now) continue;
    if (earliest === undefined || transitionAt < earliest) earliest = transitionAt;
  }
  return earliest;
};
