import type { LanesSessionId, SessionId, UnixSeconds } from '../foundation/model';
import type { LaneCatalog } from '../lane/model';
import { resolveLaneId } from '../lane/catalog';
import { judgeActivityRaw } from './activity-policy';
import type { AgentCandidate, LaneAgent, ProcSnapshot } from './model';

/**
 * 候補のレーン解決と管理セッションでの絞込
 * @param candidates - 候補列
 * @param catalog - 解決元カタログ
 * @param managedSessionIds - 管理中セッション識別子集合
 * @param proc - 参照プロセススナップショット
 * @param now - 現在時刻
 * @returns 解決済みレーンエージェント列
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
    if (!c.lanesSessionId) return [];
    if (!managedSessionIds.has(c.lanesSessionId as unknown as SessionId)) return [];

    return [
      {
        kind: c.kind,
        pid: c.pid,
        lanesSessionId: c.lanesSessionId as LanesSessionId,
        laneId,
        activity: judgeActivityRaw(c, proc, now),
      },
    ];
  });
