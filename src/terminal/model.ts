import type { AbsolutePath, LaneId, SessionId, TerminalId } from '../foundation/model';

/** ターミナルを開いた起点 */
export type TerminalOpenOrigin = 'command' | 'profile' | 'restore';

/** セッション生成仕様 */
export interface TerminalSessionSpec {
  readonly id: SessionId;
  readonly laneId: LaneId;
  readonly title: string;
  readonly cwdPath: AbsolutePath;
  readonly shellPath: AbsolutePath | undefined;
}

/** セッション記録 */
export interface TerminalSessionRecord {
  readonly spec: TerminalSessionSpec;
  readonly alive: boolean;
  readonly terminalId: TerminalId | undefined;
}

/** レーン別ターミナル記録 */
export interface LaneTerminalRecord {
  readonly sessionIds: readonly SessionId[];
  readonly lastVisibleSessionId: SessionId | undefined;
}

/** プロファイル経由で開かれた未バインドセッション */
export interface PendingTerminalOpen {
  readonly sessionId: SessionId;
  readonly origin: TerminalOpenOrigin;
}

/** ターミナル全体の状態 */
export interface TerminalState {
  readonly sessions: ReadonlyMap<SessionId, TerminalSessionRecord>;
  readonly lanes: ReadonlyMap<LaneId, LaneTerminalRecord>;
  readonly pendingOpens: readonly PendingTerminalOpen[];
}

/** 状態遷移コマンド */
export type TerminalCommand =
  | { readonly kind: 'sessionStarted'; readonly spec: TerminalSessionSpec }
  | { readonly kind: 'pendingQueued'; readonly pending: PendingTerminalOpen }
  | {
      readonly kind: 'terminalBound';
      readonly sessionId: SessionId;
      readonly terminalId: TerminalId;
    }
  | { readonly kind: 'terminalClosed'; readonly terminalId: TerminalId }
  | { readonly kind: 'sessionExited'; readonly sessionId: SessionId }
  | {
      readonly kind: 'laneRevealed';
      readonly laneId: LaneId;
      readonly visibleSessionId: SessionId;
    }
  | { readonly kind: 'laneClosed'; readonly laneId: LaneId }
  | { readonly kind: 'allDisposed' };

/** 副作用指示 */
export type TerminalEffect =
  | { readonly kind: 'spawnSession'; readonly spec: TerminalSessionSpec }
  | { readonly kind: 'attachTerminal'; readonly sessionId: SessionId; readonly title: string }
  | { readonly kind: 'showTerminal'; readonly terminalId: TerminalId }
  | { readonly kind: 'disposeTerminal'; readonly terminalId: TerminalId }
  | { readonly kind: 'killSession'; readonly sessionId: SessionId };

/** 状態遷移結果 */
export interface TerminalTransition {
  readonly state: TerminalState;
  readonly effects: readonly TerminalEffect[];
}
