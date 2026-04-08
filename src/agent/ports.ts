import type { AbsolutePath, ProcessId, SessionId, UnixSeconds } from '../foundation/model';
import type { Lane } from '../lane/model';
import type {
  AgentCandidate,
  AgentKind,
  AgentMonitorSnapshot,
  ClaudeSessionRecord,
  ProcSnapshot,
} from './model';

/** /proc スナップショット取得ポート */
export interface ProcSnapshotPort {
  readonly read: () => ProcSnapshot;
}

/** プロセス環境変数読み取りポート */
export interface ProcEnvPort {
  readonly readEnvVar: (pid: ProcessId, name: string) => string | undefined;
}

/** Claude セッション読み取りポート */
export interface ClaudeSessionPort {
  readonly list: (homePath: AbsolutePath) => readonly ClaudeSessionRecord[];
}

/** 現在時刻取得ポート */
export interface ClockPort {
  readonly nowSeconds: () => UnixSeconds;
}

/** エージェント検出ソースへの入力コンテキスト */
export interface AgentSourceContext {
  readonly proc: ProcSnapshot;
  readonly now: UnixSeconds;
  readonly idleThresholdSec: number;
}

/** エージェント検出ソース（種別ごとに1実装） */
export interface AgentSource {
  readonly kind: AgentKind;
  readonly collect: (context: AgentSourceContext) => readonly AgentCandidate[];
}

/** エージェントモニタサービス */
export interface AgentMonitorService {
  readonly refresh: (
    lanes: readonly Lane[],
    managedSessionIds: ReadonlySet<SessionId>,
  ) => AgentMonitorSnapshot;
  readonly snapshot: () => AgentMonitorSnapshot;
}
