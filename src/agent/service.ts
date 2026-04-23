import type { LanesSessionId, ProcessId, SessionId, UnixSeconds } from '../foundation/model';
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
  /** プロセススナップショット取得ポート */
  readonly proc: ProcSnapshotPort;
  /** 環境変数読み取りポート */
  readonly procEnv: ProcEnvPort;
  /** 時刻取得ポート */
  readonly clock: ClockPort;
  /** エージェント検出ソース列 */
  readonly sources: readonly AgentSource[];
  /** active 維持の猶予秒数の取得 */
  readonly getIdleThresholdSec: () => number;
}

/** エージェントモニタサービスの操作インターフェース */
export interface AgentMonitorService {
  /**
   * 状態の更新
   * @param catalog - 解決元カタログ
   * @param managedSessionIds - 管理中セッション識別子集合
   * @returns 更新後スナップショット
   */
  readonly refresh: (
    catalog: LaneCatalog,
    managedSessionIds: ReadonlySet<SessionId>,
  ) => AgentMonitorSnapshot;
  /**
   * 直近スナップショットの取得
   * @returns 直近スナップショット
   */
  readonly snapshot: () => AgentMonitorSnapshot;
}

const EMPTY_SNAPSHOT: AgentMonitorSnapshot = { agents: [], summaries: [] };

const ANCESTRY_DEPTH_LIMIT = 16;

/**
 * 候補の親子関係除去
 * @param candidates - 候補列
 * @param proc - 参照プロセススナップショット
 * @returns 重複排除済み候補列
 */
const deduplicateByAncestry = (
  candidates: readonly AgentCandidate[],
  proc: ProcSnapshot,
): readonly AgentCandidate[] => {
  const candidatePids = new Set(candidates.map((c) => c.pid));
  const ppidByPid = new Map(proc.processes.map((p) => [p.pid, p.ppid]));

  const hasAncestorCandidate = (pid: ProcessId): boolean => {
    let current = ppidByPid.get(pid);
    for (let depth = 0; current && depth < ANCESTRY_DEPTH_LIMIT; depth++) {
      if (candidatePids.has(current)) return true;
      current = ppidByPid.get(current);
    }
    return false;
  };

  return candidates.filter((c) => !hasAncestorCandidate(c.pid));
};

/**
 * エージェントモニタサービスの生成
 * @param deps - 依存
 * @returns サービスインスタンス
 */
export const createAgentMonitorService = (deps: AgentMonitorServiceDeps): AgentMonitorService => {
  let cached: AgentMonitorSnapshot = EMPTY_SNAPSHOT;
  const lastActiveAtBySession = new Map<LanesSessionId, UnixSeconds>();

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
        return envSessionId ? { ...c, lanesSessionId: envSessionId as LanesSessionId } : c;
      });

      const rawAgents = resolveLaneAgents(enriched, catalog, managedSessionIds, proc, now);

      const agents: LaneAgent[] = rawAgents.map((agent) => {
        const rawActivity = agent.activity;
        const lastActiveAt = lastActiveAtBySession.get(agent.lanesSessionId);
        const activity = applyHysteresis(rawActivity, lastActiveAt, now, idleThresholdSec);

        if (rawActivity === 'active') {
          lastActiveAtBySession.set(agent.lanesSessionId, now);
        }

        return { ...agent, activity };
      });

      const currentSessions = new Set(agents.map((a) => a.lanesSessionId));
      for (const sid of lastActiveAtBySession.keys()) {
        if (!currentSessions.has(sid)) lastActiveAtBySession.delete(sid);
      }

      const summaries = summarizeLaneAgents(agents);
      cached = { agents, summaries };
      return cached;
    },

    snapshot: () => cached,
  };
};
