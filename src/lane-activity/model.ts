import type { LaneId, TerminalId } from '../foundation/model';

/** ターミナル単位の活動状態 */
export type TerminalActivity = 'shell-prompt' | 'agent-working' | 'agent-waiting';

/** レーン単位の集約活動状態 */
export type LaneActivity = 'no-agent' | 'agent-waiting' | 'agent-working';

/** レーン活動の表示単位レコード */
export interface LaneActivityRecord {
  /** 所属レーン識別子 */
  readonly laneId: LaneId;
  /** 集約活動状態 */
  readonly activity: LaneActivity;
}

/** ターミナル活動の入力イベント (内部表現) */
export type TerminalActivityEvent =
  | {
      /** foreground コマンド開始 (OSC C 相当) */
      readonly kind: 'fg-started';
      /** 対象ターミナル識別子 */
      readonly terminalId: TerminalId;
      /** 観測時刻 (ms) */
      readonly at: number;
    }
  | {
      /** foreground コマンド終了 (OSC D 相当) */
      readonly kind: 'fg-ended';
      /** 対象ターミナル識別子 */
      readonly terminalId: TerminalId;
    }
  | {
      /** ターミナル出力観測 */
      readonly kind: 'output';
      /** 対象ターミナル識別子 */
      readonly terminalId: TerminalId;
      /** 観測時刻 (ms) */
      readonly at: number;
    }
  | {
      /** ターミナル入力観測 (打鍵) */
      readonly kind: 'input';
      /** 対象ターミナル識別子 */
      readonly terminalId: TerminalId;
      /** 観測時刻 (ms) */
      readonly at: number;
    }
  | {
      /** ターミナル消滅 (close 等) */
      readonly kind: 'forgotten';
      /** 対象ターミナル識別子 */
      readonly terminalId: TerminalId;
    };

/** ターミナル単位の活動内部状態 */
export interface TerminalActivityState {
  /** foreground コマンド実行中か (OSC C 後 D 前) */
  readonly fgRunning: boolean;
  /** 最終出力観測時刻 (ms) */
  readonly lastOutputAt: number;
  /** 最終入力観測時刻 (ms) */
  readonly lastInputAt: number;
}

/** lane-activity コンテキストの内部状態 */
export interface LaneActivityState {
  /** ターミナル単位の状態表 */
  readonly terminals: ReadonlyMap<TerminalId, TerminalActivityState>;
}
