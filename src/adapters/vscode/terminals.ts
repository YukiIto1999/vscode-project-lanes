import * as vscode from 'vscode';
import type { Disposable, TerminalId } from '../../foundation/model';
import type { ShellSessionHandle, TerminalPresentationPort } from '../../terminal/ports';

/** Pseudoterminal の入出力通知 (生イベントのみ) */
type ActivityNotifier = (event: ActivityEvent) => void;

/** ターミナル入出力の生イベント */
export type ActivityEvent =
  | { readonly kind: 'output'; readonly terminalId: TerminalId }
  | { readonly kind: 'input'; readonly terminalId: TerminalId };

/**
 * シェルセッションに接続する Pseudoterminal の生成。
 * adapter は VS Code Pseudoterminal の境界に閉じ、入力 / 出力の事実を
 * 生イベントとして外へ流すのみ。エコー判定や時刻取得は行わない
 * (それらは lane-activity 業務ルール層の責務)。
 * @param session - 接続対象シェルセッションハンドル
 * @param getTerminalId - 紐付け済みターミナル識別子の取得 (未バインド時 undefined)
 * @param notify - 生イベントの通知
 * @returns Pseudoterminal
 */
const createPseudoterminal = (
  session: ShellSessionHandle,
  getTerminalId: () => TerminalId | undefined,
  notify: ActivityNotifier,
): vscode.Pseudoterminal => {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<void>();
  let exitDisposable: Disposable | undefined;

  return {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,

    open: (dimensions) => {
      if (dimensions) session.resize(dimensions.columns, dimensions.rows);
      session.attachOutput((data) => {
        writeEmitter.fire(data);
        const tid = getTerminalId();
        if (tid) notify({ kind: 'output', terminalId: tid });
      });
      exitDisposable = session.onExit(() => closeEmitter.fire());
    },

    close: () => {
      exitDisposable?.dispose();
      session.detachOutput();
      writeEmitter.dispose();
      closeEmitter.dispose();
    },

    handleInput: (data) => {
      const tid = getTerminalId();
      if (tid) notify({ kind: 'input', terminalId: tid });
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
  /** ターミナル出力観測の生イベント */
  readonly onTerminalOutput: vscode.Event<TerminalId>;
  /** ターミナル入力観測の生イベント (handleInput 由来) */
  readonly onTerminalInput: vscode.Event<TerminalId>;
  /** onDidOpenTerminal および各イベント源の解放 */
  readonly disposable: Disposable;
}

/**
 * VS Code ターミナル表示アダプターの生成
 * @returns ターミナル表示アダプター
 */
export const createTerminalPresentationAdapter = (): TerminalPresentationAdapter => {
  let counter = 0;
  const terminalById = new Map<TerminalId, vscode.Terminal>();
  const idByTerminal = new WeakMap<vscode.Terminal, TerminalId>();
  const ownedTerminals = new Set<TerminalId>();
  const pendingProfileBindings = new WeakMap<
    vscode.Pseudoterminal,
    (terminalId: TerminalId) => void
  >();

  const outputEmitter = new vscode.EventEmitter<TerminalId>();
  const inputEmitter = new vscode.EventEmitter<TerminalId>();
  const notify: ActivityNotifier = (event) => {
    if (event.kind === 'output') outputEmitter.fire(event.terminalId);
    else inputEmitter.fire(event.terminalId);
  };

  const nextId = (): TerminalId => `terminal-${++counter}` as TerminalId;

  const registerTerminal = (terminal: vscode.Terminal): TerminalId => {
    const id = nextId();
    terminalById.set(id, terminal);
    idByTerminal.set(terminal, id);
    ownedTerminals.add(id);
    return id;
  };

  const openSubscription = vscode.window.onDidOpenTerminal((terminal) => {
    const opts = terminal.creationOptions;
    if (!('pty' in opts)) return;
    const pty = opts.pty;
    const onBound = pendingProfileBindings.get(pty);
    if (!onBound) return;
    pendingProfileBindings.delete(pty);
    const id = registerTerminal(terminal);
    onBound(id);
  });

  return {
    attachSession: (session, title) => {
      let assignedId: TerminalId | undefined;
      const pty = createPseudoterminal(session, () => assignedId, notify);
      const terminal = vscode.window.createTerminal({ name: title, pty });
      assignedId = registerTerminal(terminal);
      return assignedId;
    },

    presentAsProfile: (session, title, onBound) => {
      let assignedId: TerminalId | undefined;
      const pty = createPseudoterminal(session, () => assignedId, notify);
      pendingProfileBindings.set(pty, (terminalId) => {
        assignedId = terminalId;
        onBound(terminalId);
      });
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
          disposed.push(id);
        }
      }
      ownedTerminals.clear();
      return disposed;
    },

    resolveId: (terminal) => idByTerminal.get(terminal),

    onTerminalOutput: outputEmitter.event,
    onTerminalInput: inputEmitter.event,

    disposable: {
      dispose: () => {
        openSubscription.dispose();
        outputEmitter.dispose();
        inputEmitter.dispose();
      },
    },
  };
};
