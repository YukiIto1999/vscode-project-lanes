import type {
  AbsolutePath,
  LaneId,
  LanesSessionId,
  ProcessId,
  UnixSeconds,
} from '../foundation/model';

/** 対応エージェントの種別 */
export type AgentKind = 'claude-code' | 'codex-cli' | 'copilot-cli' | 'gemini-cli';

/** エージェントの処理状態 */
export type AgentActivity = 'idle' | 'active';

/** プロセス単位のスナップショット */
export interface ProcProcessSnapshot {
  /** プロセス識別子 */
  readonly pid: ProcessId;
  /** 親プロセス識別子 */
  readonly ppid: ProcessId;
  /** プロセス名 */
  readonly comm: string;
  /** 作業ディレクトリ絶対パス */
  readonly cwdPath: AbsolutePath | undefined;
}

/** プロセス全体の一括スナップショット */
export interface ProcSnapshot {
  /** 観測時刻 */
  readonly observedAt: UnixSeconds;
  /** プロセス列 */
  readonly processes: readonly ProcProcessSnapshot[];
}

/** Claude セッションメタデータ */
export interface ClaudeSessionRecord {
  /** プロセス識別子 */
  readonly pid: ProcessId;
  /** 作業ディレクトリ絶対パス */
  readonly cwdPath: AbsolutePath;
  /** Claude セッション識別子 */
  readonly sessionId: string;
  /** ジャーナル最終更新時刻 */
  readonly journalUpdatedAt: UnixSeconds | undefined;
}

/** ソース検出のエージェント候補 */
export interface AgentCandidate {
  /** エージェント種別 */
  readonly kind: AgentKind;
  /** プロセス識別子 */
  readonly pid: ProcessId;
  /** 作業ディレクトリ絶対パス */
  readonly cwdPath: AbsolutePath;
  /** LANES_SESSION_ID 環境変数値 */
  readonly lanesSessionId: LanesSessionId | undefined;
  /** 直近活動時刻 */
  readonly lastActivityAt: UnixSeconds | undefined;
}

/** レーン解決済みエージェント */
export interface LaneAgent {
  /** エージェント種別 */
  readonly kind: AgentKind;
  /** プロセス識別子 */
  readonly pid: ProcessId;
  /** LANES_SESSION_ID 環境変数値 */
  readonly lanesSessionId: LanesSessionId;
  /** 所属レーン識別子 */
  readonly laneId: LaneId;
  /** 処理状態 */
  readonly activity: AgentActivity;
}

/** レーン単位のエージェント集約 */
export interface LaneAgentSummary {
  /** 所属レーン識別子 */
  readonly laneId: LaneId;
  /** エージェント総数 */
  readonly totalCount: number;
  /** active 状態数 */
  readonly activeCount: number;
  /** idle 状態数 */
  readonly idleCount: number;
}

/** エージェントモニタの現在状態 */
export interface AgentMonitorSnapshot {
  /** エージェント列 */
  readonly agents: readonly LaneAgent[];
  /** レーン単位集約列 */
  readonly summaries: readonly LaneAgentSummary[];
}
