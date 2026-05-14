import type { AbsolutePath, Disposable } from '../foundation/model';
import type { AgentMonitorSnapshot } from '../agent/model';
import type { LaneServiceSnapshot } from '../lane/model';
import type { UiSnapshot } from '../ui/model';

/** 拡張機能の設定値 */
export interface ProjectLanesConfig {
  /** エージェント監視の更新間隔秒数 */
  readonly refreshIntervalSec: number;
  /** active 維持の猶予秒数 */
  readonly idleThresholdSec: number;
  /** エージェント状態の表示有無 */
  readonly showAgentStatus: boolean;
  /** シェル絶対パス */
  readonly shellPath: AbsolutePath | undefined;
}

/** アプリ全体のスナップショット */
export interface AppSnapshot {
  /** レーンサービススナップショット */
  readonly lane: LaneServiceSnapshot;
  /** エージェントモニタスナップショット */
  readonly agents: AgentMonitorSnapshot;
  /** UI スナップショット */
  readonly ui: UiSnapshot;
}

/** 設定読み取りポート */
export interface ConfigPort {
  /**
   * 現設定値の取得
   * @returns 現設定値
   */
  readonly read: () => ProjectLanesConfig;
  /**
   * 設定変更通知の購読
   * @param listener - 変更時に呼ばれるリスナー
   * @returns 購読解除可能な Disposable
   */
  readonly onDidChange: (listener: (config: ProjectLanesConfig) => void) => Disposable;
}

/** 定期実行ポート */
export interface TimerPort {
  /**
   * 周期実行の登録
   * @param intervalMs - 実行間隔ミリ秒
   * @param callback - 周期呼び出しコールバック
   * @returns 解除可能な Disposable
   */
  readonly every: (intervalMs: number, callback: () => void) => Disposable;
}
