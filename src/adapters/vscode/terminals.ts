import * as vscode from 'vscode';
import type { Disposable, TerminalId } from '../../foundation/model';
import type { ShellSessionHandle } from '../../terminal/ports';
import type { TerminalPresentationPort } from '../../terminal/ports';

/** Pseudoterminal を生成し ShellSessionHandle に接続 */
const createPseudoterminal = (session: ShellSessionHandle): vscode.Pseudoterminal => {
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

    handleInput: (data) => session.write(data),
    setDimensions: (dimensions) => session.resize(dimensions.columns, dimensions.rows),
  };
};

/** TerminalPresentationPort + vscode.Terminal 解決 */
export interface TerminalPresentationAdapter extends TerminalPresentationPort {
  /** vscode.Terminal から TerminalId の解決 */
  readonly resolveId: (terminal: vscode.Terminal) => TerminalId | undefined;
}

/** VS Code ターミナル表示ポートのアダプター */
export const createTerminalPresentationAdapter = (): TerminalPresentationAdapter => {
  let counter = 0;
  const terminalById = new Map<TerminalId, vscode.Terminal>();
  const idByTerminal = new WeakMap<vscode.Terminal, TerminalId>();
  const ownedTerminals = new Set<TerminalId>();

  const nextId = (): TerminalId => `terminal-${++counter}` as TerminalId;

  return {
    attachSession: (session, title) => {
      const pty = createPseudoterminal(session);
      const terminal = vscode.window.createTerminal({ name: title, pty });
      const id = nextId();
      terminalById.set(id, terminal);
      idByTerminal.set(terminal, id);
      ownedTerminals.add(id);
      return id;
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
  };
};
