import type { AbsolutePath, LaneId, SessionId, TerminalId } from '../foundation/model';

/** セッション生成仕様 */
export interface TerminalSessionSpec {
  /** セッション識別子 */
  readonly id: SessionId;
  /** 所属レーン識別子 */
  readonly laneId: LaneId;
  /** 表示タイトル */
  readonly title: string;
  /** 作業ディレクトリ絶対パス */
  readonly cwdPath: AbsolutePath;
  /** シェル絶対パス */
  readonly shellPath: AbsolutePath | undefined;
}

/** セッション記録 */
export interface TerminalSessionRecord {
  /** セッション仕様 */
  readonly spec: TerminalSessionSpec;
  /** 生存状態 */
  readonly alive: boolean;
  /** バインド済みターミナル識別子 */
  readonly terminalId: TerminalId | undefined;
}

/** レーン別ターミナル記録 */
export interface LaneTerminalRecord {
  /** 所属セッション識別子列 */
  readonly sessionIds: readonly SessionId[];
  /** 直近表示セッション識別子 */
  readonly lastVisibleSessionId: SessionId | undefined;
}

/** ターミナル全体の状態 */
export interface TerminalState {
  /** セッション記録の表 */
  readonly sessions: ReadonlyMap<SessionId, TerminalSessionRecord>;
  /** レーン別ターミナル記録の表 */
  readonly lanes: ReadonlyMap<LaneId, LaneTerminalRecord>;
}

/** 状態遷移コマンド */
export type TerminalCommand =
  | {
      /** セッション開始 */
      readonly kind: 'sessionStarted';
      /** セッション仕様 */
      readonly spec: TerminalSessionSpec;
    }
  | {
      /** ターミナルバインド */
      readonly kind: 'terminalBound';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
      /** バインド先ターミナル識別子 */
      readonly terminalId: TerminalId;
    }
  | {
      /** ターミナル破棄 */
      readonly kind: 'terminalClosed';
      /** 対象ターミナル識別子 */
      readonly terminalId: TerminalId;
    }
  | {
      /** セッション終了 */
      readonly kind: 'sessionExited';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
    }
  | {
      /** レーン表示 */
      readonly kind: 'laneRevealed';
      /** 対象レーン識別子 */
      readonly laneId: LaneId;
      /** 可視セッション識別子 */
      readonly visibleSessionId: SessionId;
    }
  | {
      /** レーン全終了 */
      readonly kind: 'laneClosed';
      /** 対象レーン識別子 */
      readonly laneId: LaneId;
    }
  | {
      /** 全リソース破棄 */
      readonly kind: 'allDisposed';
    };

/** 副作用指示 */
export type TerminalEffect =
  | {
      /** セッション生成 */
      readonly kind: 'spawnSession';
      /** セッション仕様 */
      readonly spec: TerminalSessionSpec;
    }
  | {
      /** ターミナル接続 */
      readonly kind: 'attachTerminal';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
      /** 表示タイトル */
      readonly title: string;
    }
  | {
      /** ターミナル前面化 */
      readonly kind: 'showTerminal';
      /** 対象ターミナル識別子 */
      readonly terminalId: TerminalId;
    }
  | {
      /** ターミナル破棄 */
      readonly kind: 'disposeTerminal';
      /** 対象ターミナル識別子 */
      readonly terminalId: TerminalId;
    }
  | {
      /** セッション強制終了 */
      readonly kind: 'killSession';
      /** 対象セッション識別子 */
      readonly sessionId: SessionId;
    };

/** 状態遷移結果 */
export interface TerminalTransition {
  /** 遷移後状態 */
  readonly state: TerminalState;
  /** 発行副作用列 */
  readonly effects: readonly TerminalEffect[];
}
