import type { Instant, LaneId, SessionId } from '../foundation/model';

/** PTY セッションを観測単位とする活動状態 */
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

/** 内部表現のセッション活動入力イベント */
export type SessionActivityEvent =
  | {
      /** foreground コマンド開始 */
      readonly kind: 'fg-started';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
      /** 観測時刻 */
      readonly at: Instant;
    }
  | {
      /** foreground コマンド終了 */
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
      /** ユーザー打鍵入力の観測 */
      readonly kind: 'input';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
      /** 観測時刻 */
      readonly at: Instant;
    }
  | {
      /** PTY exit によるセッション消滅 */
      readonly kind: 'forgotten';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
    };

/** セッション単位の活動内部状態 */
export interface SessionActivityState {
  /** foreground コマンド実行中か */
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
