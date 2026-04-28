import type { Disposable, LaneId, TerminalId } from '../foundation/model';

/** foreground コマンド開始 / 終了イベント */
export type TerminalExecutionEvent =
  | { readonly kind: 'started'; readonly terminalId: TerminalId }
  | { readonly kind: 'ended'; readonly terminalId: TerminalId };

/** foreground コマンド開始 / 終了の入力ポート (OSC 633 由来) */
export interface TerminalExecutionEventPort {
  /**
   * イベント購読の開始
   * @param handler - イベントハンドラー
   * @returns 購読解除可能な Disposable
   */
  readonly subscribe: (handler: (event: TerminalExecutionEvent) => void) => Disposable;
}

/** ターミナル出力観測イベント */
export interface TerminalOutputEvent {
  /** 対象ターミナル識別子 */
  readonly terminalId: TerminalId;
}

/** ターミナル出力の入力ポート (PTY data 由来) */
export interface TerminalOutputEventPort {
  /**
   * イベント購読の開始
   * @param handler - イベントハンドラー
   * @returns 購読解除可能な Disposable
   */
  readonly subscribe: (handler: (event: TerminalOutputEvent) => void) => Disposable;
}

/** ターミナル入力観測イベント */
export interface TerminalInputEvent {
  /** 対象ターミナル識別子 */
  readonly terminalId: TerminalId;
}

/** ターミナル入力の入力ポート (Pseudoterminal handleInput 由来) */
export interface TerminalInputEventPort {
  /**
   * イベント購読の開始
   * @param handler - イベントハンドラー
   * @returns 購読解除可能な Disposable
   */
  readonly subscribe: (handler: (event: TerminalInputEvent) => void) => Disposable;
}

/** ターミナル破棄通知の入力ポート */
export interface TerminalLifecycleEventPort {
  /**
   * 破棄通知の購読
   * @param handler - 破棄ハンドラー
   * @returns 購読解除可能な Disposable
   */
  readonly subscribe: (handler: (terminalId: TerminalId) => void) => Disposable;
}

/** ターミナルからレーンを引く照会ポート */
export interface LaneResolverPort {
  /**
   * ターミナル識別子からのレーン識別子解決
   * @param terminalId - 対象ターミナル識別子
   * @returns 該当レーン識別子、または不一致で undefined
   */
  readonly resolveLaneByTerminal: (terminalId: TerminalId) => LaneId | undefined;
}

/** 単調時刻取得ポート */
export interface MonotonicClockPort {
  /**
   * 現在時刻 (ms)
   * @returns ms 単位の現在時刻
   */
  readonly now: () => number;
}
