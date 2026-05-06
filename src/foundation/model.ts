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

/** VS Code ターミナルの不透明識別子 */
export type TerminalId = Brand<string, 'TerminalId'>;

/** 単調時刻 (ms 単位の観測時刻。MonotonicClockPort 経由で取得) */
export type Instant = Brand<number, 'Instant'>;

/** 破棄可能なリソース */
export interface Disposable {
  /** 破棄処理 */
  readonly dispose: () => void;
}
