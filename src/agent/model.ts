import type { AbsolutePath, LaneId, ProcessId, UnixSeconds } from '../foundation/model';

/** 対応エージェントの種別 */
export type AgentKind = 'claude-code' | 'codex-cli' | 'copilot-cli' | 'gemini-cli';

/** エージェントの処理状態 */
export type AgentActivity = 'idle' | 'active';

/** /proc から取得したプロセス情報 */
export interface ProcProcessSnapshot {
  readonly pid: ProcessId;
  readonly ppid: ProcessId;
  readonly comm: string;
  readonly cwdPath: AbsolutePath | undefined;
}

/** /proc の一括スナップショット */
export interface ProcSnapshot {
  readonly observedAt: UnixSeconds;
  readonly processes: readonly ProcProcessSnapshot[];
}

/** Claude セッションメタデータ */
export interface ClaudeSessionRecord {
  readonly pid: ProcessId;
  readonly cwdPath: AbsolutePath;
  readonly sessionId: string;
  readonly journalUpdatedAt: UnixSeconds | undefined;
}

/** ソースが検出した未解決エージェント候補 */
export interface AgentCandidate {
  readonly kind: AgentKind;
  readonly pid: ProcessId;
  readonly cwdPath: AbsolutePath;
  readonly lanesSessionId: string | undefined;
  readonly lastActivityAt: UnixSeconds | undefined;
}

/** レーン解決済みエージェント */
export interface LaneAgent {
  readonly kind: AgentKind;
  readonly pid: ProcessId;
  readonly laneId: LaneId;
  readonly activity: AgentActivity;
}

/** レーン単位のエージェント状態集約 */
export interface LaneAgentSummary {
  readonly laneId: LaneId;
  readonly totalCount: number;
  readonly activeCount: number;
  readonly idleCount: number;
}

/** エージェントモニタの現在状態 */
export interface AgentMonitorSnapshot {
  readonly agents: readonly LaneAgent[];
  readonly summaries: readonly LaneAgentSummary[];
}
