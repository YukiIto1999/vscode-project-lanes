import type { Instant, LaneId, SessionId } from '../foundation/model';

/** セッション単位の活動状態 (PTY セッションを観測単位とする) */
export type SessionActivity = 'shell-prompt' | 'agent-working' | 'agent-waiting';

/** レーン単位の集約活動状態 */
export type LaneActivity = 'no-agent' | 'agent-waiting' | 'agent-working';

/** レーン活動の表示単位レコード */
export interface LaneActivityRecord {
  /** 所属レーン識別子 */
  readonly laneId: LaneId;
  /** 集約活動状態 */
  readonly activity: LaneActivity;
}

/** セッション活動の入力イベント (内部表現) */
export type SessionActivityEvent =
  | {
      /** foreground コマンド開始 (OSC 633 ;C 相当) */
      readonly kind: 'fg-started';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
      /** 観測時刻 */
      readonly at: Instant;
    }
  | {
      /** foreground コマンド終了 (OSC 633 ;D 相当) */
      readonly kind: 'fg-ended';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
    }
  | {
      /** PTY 出力観測 */
      readonly kind: 'output';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
      /** 観測時刻 */
      readonly at: Instant;
    }
  | {
      /** ユーザー入力観測 (打鍵) */
      readonly kind: 'input';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
      /** 観測時刻 */
      readonly at: Instant;
    }
  | {
      /** セッション消滅 (PTY exit 等) */
      readonly kind: 'forgotten';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
    };

/** セッション単位の活動内部状態 */
export interface SessionActivityState {
  /** foreground コマンド実行中か (OSC 633 ;C 後 ;D 前) */
  readonly fgRunning: boolean;
  /** 最終出力観測時刻 */
  readonly lastOutputAt: Instant;
  /** 最終入力観測時刻 */
  readonly lastInputAt: Instant;
}

/** lane-activity コンテキストの内部状態 */
export interface LaneActivityState {
  /** セッション単位の状態表 */
  readonly sessions: ReadonlyMap<SessionId, SessionActivityState>;
}
