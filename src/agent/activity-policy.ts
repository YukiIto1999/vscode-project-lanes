import type { UnixSeconds } from '../foundation/model';
import type { AgentActivity, AgentCandidate, ProcSnapshot } from './model';

/** 候補の活動状態を即時判定
 *
 * claude-code: journal の mtime で判定
 * その他: 子プロセスの有無で判定。
 */
export const judgeActivityRaw = (
  candidate: AgentCandidate,
  proc: ProcSnapshot,
  now: UnixSeconds,
): AgentActivity => {
  if (candidate.kind === 'claude-code') {
    if (candidate.lastActivityAt === undefined) return 'idle';
    // journal mtime が1秒以内なら active（即時検知）
    return now - candidate.lastActivityAt <= 1 ? 'active' : 'idle';
  }

  const hasChild = proc.processes.some((p) => p.ppid === candidate.pid);
  return hasChild ? 'active' : 'idle';
};

/** ヒステリシス付き活動状態の決定
 *
 * idle→active: 即時（raw が active なら即 active）
 * active→idle: 猶予あり（raw が idle でも閾値秒間は active を維持）
 */
export const applyHysteresis = (
  rawActivity: AgentActivity,
  lastActiveAt: UnixSeconds | undefined,
  now: UnixSeconds,
  idleThresholdSec: number,
): AgentActivity => {
  if (rawActivity === 'active') return 'active';
  // raw が idle でも、直近に active だった場合は猶予
  if (lastActiveAt !== undefined && now - lastActiveAt <= idleThresholdSec) return 'active';
  return 'idle';
};
