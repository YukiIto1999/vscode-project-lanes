import * as vscode from 'vscode';
import type { Disposable, SessionId, TerminalId } from '../../foundation/model';
import type { SessionActivitySink } from '../../lane-activity/ports';
import type { ShellSessionHandle, TerminalPresentationPort } from '../../terminal/ports';

/**
 * シェルセッションに接続する Pseudoterminal の生成。
 * adapter は VS Code Pseudoterminal の境界に閉じ、入力観測の事実のみ
 * activity sink に流す。出力観測は PTY 層 (node-pty 常設リスナ) が担当する
 * ため Pseudoterminal は関与しない。
 * @param session - 接続対象シェルセッションハンドル
 * @param sink - セッション活動の事実流入口
 * @returns Pseudoterminal
 */
const createPseudoterminal = (
  session: ShellSessionHandle,
  sink: SessionActivitySink,
): vscode.Pseudoterminal => {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<void>();
  let exitDisposable: Disposable | undefined;

  return {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,

    open: (dimensions) => {
      if (dimensions) session.resize(dimensions.columns, dimensions.rows);
      session.attachOutput((data) => writeEmitter.fire(data));
      exitDisposable = session.onExit(() => closeEmitter.fire());
    },

    close: () => {
      exitDisposable?.dispose();
      session.detachOutput();
      writeEmitter.dispose();
      closeEmitter.dispose();
    },

    handleInput: (data) => {
      sink.input(session.id);
      session.write(data);
    },
    setDimensions: (dimensions) => session.resize(dimensions.columns, dimensions.rows),
  };
};

/** ターミナル表示ポート拡張 */
export interface TerminalPresentationAdapter extends TerminalPresentationPort {
  /**
   * vscode.Terminal からの ターミナル識別子解決
   * @param terminal - 対象ターミナル
   * @returns 該当ターミナル識別子、または不一致で undefined
   */
  readonly resolveId: (terminal: vscode.Terminal) => TerminalId | undefined;
  /**
   * vscode.Terminal からのセッション識別子解決
   * @param terminal - 対象ターミナル
   * @returns 該当セッション識別子、または不一致で undefined
   */
  readonly resolveSessionId: (terminal: vscode.Terminal) => SessionId | undefined;
  /**
   * シェルセッションの TerminalProfile としての提示
   * @param session - 接続対象シェルセッションハンドル
   * @param title - 表示タイトル
   * @param onBound - Terminal 生成完了時のコールバック
   * @returns 渡可能な TerminalProfile
   */
  readonly presentAsProfile: (
    session: ShellSessionHandle,
    title: string,
    onBound: (terminalId: TerminalId) => void,
  ) => vscode.TerminalProfile;
  /** onDidOpenTerminal 購読の解放 */
  readonly disposable: Disposable;
}

/** ターミナル表示アダプターの依存 */
export interface TerminalPresentationAdapterDeps {
  /** セッション活動の事実流入口 */
  readonly activitySink: SessionActivitySink;
}

/** profile 経由生成時の保留情報 */
interface ProfilePending {
  readonly sessionId: SessionId;
  readonly onBound: (terminalId: TerminalId) => void;
}

/**
 * VS Code ターミナル表示アダプターの生成
 * @param deps - 依存
 * @returns ターミナル表示アダプター
 */
export const createTerminalPresentationAdapter = (
  deps: TerminalPresentationAdapterDeps,
): TerminalPresentationAdapter => {
  let counter = 0;
  const terminalById = new Map<TerminalId, vscode.Terminal>();
  const sessionIdByTerminalId = new Map<TerminalId, SessionId>();
  const idByTerminal = new WeakMap<vscode.Terminal, TerminalId>();
  const ownedTerminals = new Set<TerminalId>();
  const pendingProfile = new WeakMap<vscode.Pseudoterminal, ProfilePending>();

  const nextId = (): TerminalId => `terminal-${++counter}` as TerminalId;

  const registerTerminal = (terminal: vscode.Terminal, sessionId: SessionId): TerminalId => {
    const id = nextId();
    terminalById.set(id, terminal);
    idByTerminal.set(terminal, id);
    sessionIdByTerminalId.set(id, sessionId);
    ownedTerminals.add(id);
    return id;
  };

  const openSubscription = vscode.window.onDidOpenTerminal((terminal) => {
    const opts = terminal.creationOptions;
    if (!('pty' in opts)) return;
    const pending = pendingProfile.get(opts.pty);
    if (!pending) return;
    pendingProfile.delete(opts.pty);
    const id = registerTerminal(terminal, pending.sessionId);
    pending.onBound(id);
  });

  return {
    attachSession: (session, title) => {
      const pty = createPseudoterminal(session, deps.activitySink);
      const terminal = vscode.window.createTerminal({ name: title, pty });
      return registerTerminal(terminal, session.id);
    },

    presentAsProfile: (session, title, onBound) => {
      const pty = createPseudoterminal(session, deps.activitySink);
      pendingProfile.set(pty, { sessionId: session.id, onBound });
      return new vscode.TerminalProfile({ name: title, pty });
    },

    showTerminal: (terminalId) => {
      terminalById.get(terminalId)?.show();
    },

    disposeTerminal: (terminalId) => {
      const terminal = terminalById.get(terminalId);
      if (terminal) {
        terminal.dispose();
        terminalById.delete(terminalId);
        sessionIdByTerminalId.delete(terminalId);
        ownedTerminals.delete(terminalId);
      }
    },

    disposeAllOwned: () => {
      const disposed: TerminalId[] = [];
      for (const id of ownedTerminals) {
        const terminal = terminalById.get(id);
        if (terminal) {
          terminal.dispose();
          terminalById.delete(id);
          sessionIdByTerminalId.delete(id);
          disposed.push(id);
        }
      }
      ownedTerminals.clear();
      return disposed;
    },

    resolveId: (terminal) => idByTerminal.get(terminal),
    resolveSessionId: (terminal) => {
      const id = idByTerminal.get(terminal);
      return id ? sessionIdByTerminalId.get(id) : undefined;
    },

    disposable: {
      dispose: () => openSubscription.dispose(),
    },
  };
};
