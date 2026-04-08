import type { AbsolutePath, LaneId, TerminalId } from '../foundation/model';
import type { Disposable } from '../foundation/model';
import type { AgentMonitorSnapshot } from '../agent/model';
import type { LaneServiceSnapshot } from '../lane/model';
import type { UiSnapshot } from '../ui/model';

/** 拡張機能の設定値 */
export interface ProjectLanesConfig {
  readonly refreshIntervalSec: number;
  readonly idleThresholdSec: number;
  readonly showAgentStatus: boolean;
  readonly shellPath: AbsolutePath | undefined;
}

/** アプリ全体のスナップショット */
export interface AppSnapshot {
  readonly lane: LaneServiceSnapshot;
  readonly agents: AgentMonitorSnapshot;
  readonly ui: UiSnapshot;
}

/** アプリランタイムの操作インターフェース */
export interface ProjectLanesRuntime {
  readonly initialize: () => Promise<void>;
  readonly focusLane: (laneId?: LaneId) => Promise<void>;
  readonly unfocus: () => Promise<void>;
  readonly closeActiveLaneTerminals: () => Promise<void>;
  readonly handleTerminalOpened: (terminalId: TerminalId) => void;
  readonly handleTerminalClosed: (terminalId: TerminalId) => void;
  readonly dispose: () => void;
}

/** 設定読み取りポート */
export interface ConfigPort {
  readonly read: () => ProjectLanesConfig;
  readonly onDidChange: (listener: (config: ProjectLanesConfig) => void) => Disposable;
}

/** 定期実行ポート */
export interface TimerPort {
  readonly every: (intervalMs: number, callback: () => void) => Disposable;
}
