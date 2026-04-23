import type { Disposable, LaneId, SessionId, TerminalId } from '../foundation/model';
import type { TerminalSessionSpec } from './model';

/** シェルセッションのハンドル */
export interface ShellSessionHandle {
  /** セッション識別子 */
  readonly id: SessionId;
  /**
   * 入力データの送信
   * @param data - 送信文字列
   */
  readonly write: (data: string) => void;
  /**
   * 端末サイズの変更
   * @param columns - 列数
   * @param rows - 行数
   */
  readonly resize: (columns: number, rows: number) => void;
  /**
   * 出力購読の開始
   * @param listener - 出力チャンクのリスナー
   */
  readonly attachOutput: (listener: (chunk: string) => void) => void;
  /** 出力購読の停止 */
  readonly detachOutput: () => void;
  /**
   * 終了リスナー登録
   * @param listener - 終了時に呼ばれるリスナー
   * @returns 購読解除可能な Disposable
   */
  readonly onExit: (listener: () => void) => Disposable;
  /** プロセスの強制終了 */
  readonly kill: () => void;
  /**
   * 生存判定
   * @returns 生存中なら true
   */
  readonly isAlive: () => boolean;
}

/** シェルセッション生成ポート */
export interface ShellSessionFactoryPort {
  /**
   * セッションの生成
   * @param spec - セッション仕様
   * @returns 生成済みハンドル
   */
  readonly create: (spec: TerminalSessionSpec) => ShellSessionHandle;
}

/** VS Code ターミナル表示ポート */
export interface TerminalPresentationPort {
  /**
   * セッションへのターミナル接続
   * @param session - 対象セッションハンドル
   * @param title - 表示タイトル
   * @returns 生成ターミナル識別子
   */
  readonly attachSession: (session: ShellSessionHandle, title: string) => TerminalId;
  /**
   * ターミナルの前面化
   * @param terminalId - 対象ターミナル識別子
   */
  readonly showTerminal: (terminalId: TerminalId) => void;
  /**
   * ターミナルの破棄
   * @param terminalId - 対象ターミナル識別子
   */
  readonly disposeTerminal: (terminalId: TerminalId) => void;
  /**
   * 管理下ターミナルの一括破棄
   * @returns 破棄したターミナル識別子列
   */
  readonly disposeAllOwned: () => readonly TerminalId[];
}

/** セッション ID 採番ポート */
export interface SessionIdPort {
  /**
   * 次のセッション識別子の発行
   * @param laneId - 所属レーン識別子
   * @returns 新規セッション識別子
   */
  readonly next: (laneId: LaneId) => SessionId;
}
