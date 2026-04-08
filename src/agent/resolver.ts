import type { SessionId, UnixSeconds } from '../foundation/model';
import type { LaneCatalog } from '../lane/model';
import { resolveLaneId } from '../lane/catalog';
import { judgeActivityRaw } from './activity-policy';
import type { AgentCandidate, LaneAgent, ProcSnapshot } from './model';

/** 候補をレーン解決し、managed session でフィルタリング
 *
 * activity は raw 判定
 */
export const resolveLaneAgents = (
  candidates: readonly AgentCandidate[],
  catalog: LaneCatalog,
  managedSessionIds: ReadonlySet<SessionId>,
  proc: ProcSnapshot,
  now: UnixSeconds,
): readonly LaneAgent[] =>
  candidates.flatMap((c) => {
    const laneId = resolveLaneId(c.cwdPath, catalog);
    if (!laneId) return [];

    if (managedSessionIds.size > 0) {
      if (!c.lanesSessionId) return [];
      if (!managedSessionIds.has(c.lanesSessionId as SessionId)) return [];
    }

    return [
      {
        kind: c.kind,
        pid: c.pid,
        laneId,
        activity: judgeActivityRaw(c, proc, now),
      },
    ];
  });
