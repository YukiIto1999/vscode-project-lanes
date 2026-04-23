/**
 * 名前付きブランド型
 * @typeParam T - 基底プリミティブ型
 * @typeParam Name - 識別名
 */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

/** 絶対ファイルパス */
export type AbsolutePath = Brand<string, 'AbsolutePath'>;

/** file:// スキーム URI 文字列 */
export type UriString = Brand<string, 'UriString'>;

/** ワークスペース永続キー */
export type WorkspaceKey = Brand<string, 'WorkspaceKey'>;

/** レーン識別子 */
export type LaneId = Brand<string, 'LaneId'>;

/** ターミナルセッション識別子 */
export type SessionId = Brand<string, 'SessionId'>;

/** LANES_SESSION_ID 環境変数値 */
export type LanesSessionId = Brand<string, 'LanesSessionId'>;

/** VS Code ターミナルの不透明識別子 */
export type TerminalId = Brand<string, 'TerminalId'>;

/** OS プロセス ID */
export type ProcessId = Brand<number, 'ProcessId'>;

/** UNIX エポック秒 */
export type UnixSeconds = Brand<number, 'UnixSeconds'>;

/** 破棄可能なリソース */
export interface Disposable {
  /** 破棄処理 */
  readonly dispose: () => void;
}
