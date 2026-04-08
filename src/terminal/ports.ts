import type { Disposable, LaneId, SessionId, TerminalId } from '../foundation/model';
import type { TerminalSessionSpec } from './model';

/** シェルセッションハンドル（node-pty の抽象化） */
export interface ShellSessionHandle {
  readonly id: SessionId;
  readonly write: (data: string) => void;
  readonly resize: (columns: number, rows: number) => void;
  readonly attachOutput: (listener: (chunk: string) => void) => void;
  readonly detachOutput: () => void;
  /** 終了リスナー登録（Disposable で解除可能） */
  readonly onExit: (listener: () => void) => Disposable;
  readonly kill: () => void;
  readonly isAlive: () => boolean;
}

/** シェルセッション生成ポート */
export interface ShellSessionFactoryPort {
  readonly create: (spec: TerminalSessionSpec) => ShellSessionHandle;
}

/** VS Code ターミナル表示ポート */
export interface TerminalPresentationPort {
  readonly attachSession: (session: ShellSessionHandle, title: string) => TerminalId;
  readonly showTerminal: (terminalId: TerminalId) => void;
  readonly disposeTerminal: (terminalId: TerminalId) => void;
  readonly disposeAllOwned: () => readonly TerminalId[];
}

/** セッション ID 採番ポート */
export interface SessionIdPort {
  readonly next: (laneId: LaneId) => SessionId;
}
