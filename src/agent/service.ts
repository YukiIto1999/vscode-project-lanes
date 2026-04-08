import type { ProcessId, SessionId, UnixSeconds } from '../foundation/model';
import type { LaneCatalog } from '../lane/model';
import type { AgentCandidate, AgentMonitorSnapshot, LaneAgent, ProcSnapshot } from './model';
import { applyHysteresis } from './activity-policy';
import type {
  AgentSource,
  AgentSourceContext,
  ClockPort,
  ProcEnvPort,
  ProcSnapshotPort,
} from './ports';
import { resolveLaneAgents } from './resolver';
import { summarizeLaneAgents } from './summarizer';

/** エージェントモニタサービスの依存 */
export interface AgentMonitorServiceDeps {
  readonly proc: ProcSnapshotPort;
  readonly procEnv: ProcEnvPort;
  readonly clock: ClockPort;
  readonly sources: readonly AgentSource[];
  /** active→idle 遷移の猶予秒数 */
  readonly getIdleThresholdSec: () => number;
}

/** エージェントモニタサービスの操作インターフェース */
export interface AgentMonitorService {
  readonly refresh: (
    catalog: LaneCatalog,
    managedSessionIds: ReadonlySet<SessionId>,
  ) => AgentMonitorSnapshot;
  readonly snapshot: () => AgentMonitorSnapshot;
}

const EMPTY_SNAPSHOT: AgentMonitorSnapshot = { agents: [], summaries: [] };

/** 候補の親子関係を排除（子プロセスが別ソースで検出された場合の重複防止） */
const deduplicateByAncestry = (
  candidates: readonly AgentCandidate[],
  proc: ProcSnapshot,
): readonly AgentCandidate[] => {
  const candidatePids = new Set(candidates.map((c) => c.pid));
  const ppidByPid = new Map(proc.processes.map((p) => [p.pid, p.ppid]));

  const hasAncestorCandidate = (pid: ProcessId): boolean => {
    let current = ppidByPid.get(pid);
    for (let depth = 0; current && depth < 16; depth++) {
      if (candidatePids.has(current)) return true;
      current = ppidByPid.get(current);
    }
    return false;
  };

  return candidates.filter((c) => !hasAncestorCandidate(c.pid));
};

/** エージェントモニタサービスの生成 */
export const createAgentMonitorService = (deps: AgentMonitorServiceDeps): AgentMonitorService => {
  let cached: AgentMonitorSnapshot = EMPTY_SNAPSHOT;
  /** PID ごとの最終 active 検知時刻（ヒステリシス用） */
  const lastActiveAtByPid = new Map<ProcessId, UnixSeconds>();

  return {
    refresh: (catalog, managedSessionIds) => {
      const idleThresholdSec = deps.getIdleThresholdSec();
      const proc = deps.proc.read();
      const now = deps.clock.nowSeconds();
      const context: AgentSourceContext = { proc, now, idleThresholdSec };

      const rawCandidates = deps.sources.flatMap((source) => source.collect(context));
      const candidates = deduplicateByAncestry(rawCandidates, proc);

      const enriched = candidates.map((c) => {
        const envSessionId = deps.procEnv.readEnvVar(c.pid, 'LANES_SESSION_ID');
        return envSessionId ? { ...c, lanesSessionId: envSessionId } : c;
      });

      const rawAgents = resolveLaneAgents(enriched, catalog, managedSessionIds, proc, now);

      // ヒステリシス適用
      const agents: LaneAgent[] = rawAgents.map((agent) => {
        const rawActivity = agent.activity;
        const lastActiveAt = lastActiveAtByPid.get(agent.pid);
        const activity = applyHysteresis(rawActivity, lastActiveAt, now, idleThresholdSec);

        // raw が active の時だけタイマーを更新（ヒステリシス出力で更新すると永遠に切れない）
        if (rawActivity === 'active') {
          lastActiveAtByPid.set(agent.pid, now);
        }

        return { ...agent, activity };
      });

      // 消えた PID のエントリをクリーンアップ
      const currentPids = new Set(agents.map((a) => a.pid));
      for (const pid of lastActiveAtByPid.keys()) {
        if (!currentPids.has(pid)) lastActiveAtByPid.delete(pid);
      }

      const summaries = summarizeLaneAgents(agents);
      cached = { agents, summaries };
      return cached;
    },

    snapshot: () => cached,
  };
};
