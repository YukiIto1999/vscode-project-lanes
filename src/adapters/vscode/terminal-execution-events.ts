import * as vscode from 'vscode';
import type { Disposable, TerminalId } from '../../foundation/model';
import type { TerminalExecutionEvent, TerminalExecutionEventPort } from '../../lane-activity/ports';

/** ターミナル → 識別子解決の照会関数 */
export type TerminalIdResolver = (terminal: vscode.Terminal) => TerminalId | undefined;

/** ターミナル実行イベントアダプター */
export interface TerminalExecutionEventAdapter extends TerminalExecutionEventPort {
  /** VS Code 購読の解放 */
  readonly disposable: Disposable;
}

/**
 * VS Code Shell Integration イベントから TerminalExecutionEventPort を生成
 * @param resolveTerminalId - vscode.Terminal → TerminalId の照会関数
 * @returns イベントアダプター
 */
export const createTerminalExecutionEventAdapter = (
  resolveTerminalId: TerminalIdResolver,
): TerminalExecutionEventAdapter => {
  const handlers: Array<(event: TerminalExecutionEvent) => void> = [];

  const fire = (event: TerminalExecutionEvent): void => {
    for (const handler of handlers) handler(event);
  };

  const startSubscription = vscode.window.onDidStartTerminalShellExecution((event) => {
    const terminalId = resolveTerminalId(event.terminal);
    if (terminalId) fire({ kind: 'started', terminalId });
  });

  const endSubscription = vscode.window.onDidEndTerminalShellExecution((event) => {
    const terminalId = resolveTerminalId(event.terminal);
    if (terminalId) fire({ kind: 'ended', terminalId });
  });

  return {
    subscribe: (handler) => {
      handlers.push(handler);
      return {
        dispose: () => {
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        },
      };
    },
    disposable: {
      dispose: () => {
        startSubscription.dispose();
        endSubscription.dispose();
        handlers.length = 0;
      },
    },
  };
};
