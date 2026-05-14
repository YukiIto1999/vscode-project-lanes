import type { AbsolutePath, ProcessId, SessionId, UnixSeconds } from '../foundation/model';
import type { Lane } from '../lane/model';
import type {
  AgentCandidate,
  AgentKind,
  AgentMonitorSnapshot,
  ClaudeSessionRecord,
  ProcSnapshot,
} from './model';

/** プロセススナップショット取得ポート */
export interface ProcSnapshotPort {
  /**
   * プロセス全体スナップショットの取得
   * @returns プロセススナップショット
   */
  readonly read: () => ProcSnapshot;
}

/** プロセス環境変数読み取りポート */
export interface ProcEnvPort {
  /**
   * 環境変数値の読み取り
   * @param pid - 対象プロセス識別子
   * @param name - 環境変数名
   * @returns 環境変数値、または不在で undefined
   */
  readonly readEnvVar: (pid: ProcessId, name: string) => string | undefined;
}

/** Claude セッション読み取りポート */
export interface ClaudeSessionPort {
  /**
   * Claude セッション一覧の取得
   * @param homePath - ホームディレクトリ絶対パス
   * @returns Claude セッション列
   */
  readonly list: (homePath: AbsolutePath) => readonly ClaudeSessionRecord[];
}

/** 現在時刻取得ポート */
export interface ClockPort {
  /**
   * 現在時刻の取得
   * @returns UNIX エポック秒
   */
  readonly nowSeconds: () => UnixSeconds;
}

/** エージェント検出ソースへの入力コンテキスト */
export interface AgentSourceContext {
  /** プロセススナップショット */
  readonly proc: ProcSnapshot;
  /** 現在時刻 */
  readonly now: UnixSeconds;
  /** idle 判定閾値秒数 */
  readonly idleThresholdSec: number;
}

/** エージェント検出ソース */
export interface AgentSource {
  /** 検出対象の種別 */
  readonly kind: AgentKind;
  /**
   * 候補の収集
   * @param context - 入力コンテキスト
   * @returns 候補列
   */
  readonly collect: (context: AgentSourceContext) => readonly AgentCandidate[];
}

/** エージェントモニタサービス */
export interface AgentMonitorService {
  /**
   * 監視状態の更新
   * @param lanes - 対象レーン列
   * @param managedSessionIds - 管理中セッション識別子集合
   * @returns 更新後スナップショット
   */
  readonly refresh: (
    lanes: readonly Lane[],
    managedSessionIds: ReadonlySet<SessionId>,
  ) => AgentMonitorSnapshot;
  /**
   * 直近スナップショットの取得
   * @returns 直近スナップショット
   */
  readonly snapshot: () => AgentMonitorSnapshot;
}
