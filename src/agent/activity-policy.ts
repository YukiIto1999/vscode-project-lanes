import type { UnixSeconds } from '../foundation/model';
import type { AgentActivity, AgentCandidate, ProcSnapshot } from './model';

/**
 * 候補の活動状態の即時判定
 * @param candidate - 判定対象候補
 * @param proc - 参照プロセススナップショット
 * @param now - 現在時刻
 * @returns 活動状態
 */
export const judgeActivityRaw = (
  candidate: AgentCandidate,
  proc: ProcSnapshot,
  now: UnixSeconds,
): AgentActivity => {
  if (candidate.kind === 'claude-code') {
    if (candidate.lastActivityAt === undefined) return 'idle';
    return now - candidate.lastActivityAt <= 1 ? 'active' : 'idle';
  }

  const hasChild = proc.processes.some((p) => p.ppid === candidate.pid);
  return hasChild ? 'active' : 'idle';
};

/**
 * ヒステリシス付き活動状態の決定
 * @param rawActivity - 即時判定結果
 * @param lastActiveAt - 直近 active 検知時刻
 * @param now - 現在時刻
 * @param idleThresholdSec - active 維持の猶予秒数
 * @returns 活動状態
 */
export const applyHysteresis = (
  rawActivity: AgentActivity,
  lastActiveAt: UnixSeconds | undefined,
  now: UnixSeconds,
  idleThresholdSec: number,
): AgentActivity => {
  if (rawActivity === 'active') return 'active';
  if (lastActiveAt !== undefined && now - lastActiveAt <= idleThresholdSec) return 'active';
  return 'idle';
};
