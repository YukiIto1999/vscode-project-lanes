import type { Instant, LaneId, SessionId } from '../foundation/model';

/**
 * セッション活動の事実を受け付ける書込口。
 * adapter から domain への単方向流入。`at` は受け側 (service) で
 * 単調時刻を採番するため引数からは省く。
 */
export interface SessionActivitySink {
  /**
   * foreground コマンド開始の通知 (OSC 633 ;C 相当)
   * @param sessionId - 対象セッション識別子
   */
  readonly executionStarted: (sessionId: SessionId) => void;
  /**
   * foreground コマンド終了の通知 (OSC 633 ;D 相当)
   * @param sessionId - 対象セッション識別子
   */
  readonly executionEnded: (sessionId: SessionId) => void;
  /**
   * PTY 出力観測の通知
   * @param sessionId - 対象セッション識別子
   */
  readonly output: (sessionId: SessionId) => void;
  /**
   * ユーザー入力観測の通知 (Pseudoterminal handleInput 相当)
   * @param sessionId - 対象セッション識別子
   */
  readonly input: (sessionId: SessionId) => void;
  /**
   * セッション消滅の通知 (PTY exit 相当)
   * @param sessionId - 対象セッション識別子
   */
  readonly forgotten: (sessionId: SessionId) => void;
}

/** セッションからレーンを引く照会ポート */
export interface LaneResolverPort {
  /**
   * セッション識別子からのレーン識別子解決
   * @param sessionId - 対象セッション識別子
   * @returns 該当レーン識別子、または不一致で undefined
   */
  readonly resolveLaneBySession: (sessionId: SessionId) => LaneId | undefined;
}

/** 単調時刻取得ポート */
export interface MonotonicClockPort {
  /**
   * 現在時刻
   * @returns 観測時刻
   */
  readonly now: () => Instant;
}
